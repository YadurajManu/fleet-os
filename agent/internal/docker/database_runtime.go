package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/fleet-os/fleet-os/agent/internal/capability"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DatabaseRuntime persists receipts, never plans or credentials. The control plane resends encrypted operation inputs after reconnect.
type DatabaseRuntime struct {
	Docker  *Client
	NodeID  string
	FleetID string
	Dir     string
	mu      sync.Mutex
}

type DatabaseOperation struct {
	Images       []DatabaseImage         `json:"images,omitempty"`
	RegistryAuth string                  `json:"registryAuth,omitempty"`
	ReserveBytes int64                   `json:"reserveBytes,omitempty"`
	Restore      *DatabaseRestore        `json:"restore,omitempty"`
	ID           string                  `json:"id"`
	Action       string                  `json:"action"`
	Identity     DatabaseIdentity        `json:"identity"`
	Containers   []DatabaseContainerSpec `json:"containers,omitempty"`
	Bootstrap    *DatabaseCommand        `json:"bootstrap,omitempty"`
	Readiness    *DatabaseCommand        `json:"readiness,omitempty"`
}

type DatabaseRestore struct {
	Kind           string            `json:"kind,omitempty"`
	BackupName     string            `json:"backupName"`
	TargetTime     string            `json:"targetTime,omitempty"`
	TargetName     string            `json:"targetName,omitempty"`
	Env            map[string]string `json:"env"`
	Files          []DatabaseFile    `json:"files"`
	PostCommands   []DatabaseCommand `json:"postCommands,omitempty"`
	FinalReadiness *DatabaseCommand  `json:"finalReadiness,omitempty"`
}

type DatabaseReceipt struct {
	Identity     DatabaseIdentity `json:"identity"`
	OperationID  string           `json:"operationId"`
	Action       string           `json:"action"`
	Fingerprint  string           `json:"fingerprint"`
	Phase        string           `json:"phase"`
	Roles        []string         `json:"roles"`
	Initialized  bool             `json:"initialized"`
	Bootstrapped bool             `json:"bootstrapped"`
	Complete     bool             `json:"complete"`
}

func (r *DatabaseRuntime) read(id string) (*DatabaseReceipt, error) {
	file, err := os.Open(filepath.Join(r.Dir, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, databaseFailure("receipt read")
	}
	defer file.Close()
	var receipt DatabaseReceipt
	decoder := json.NewDecoder(io.LimitReader(file, 16385))
	if decoder.Decode(&receipt) != nil || !receipt.Identity.valid() || receipt.Identity.ID != id {
		return nil, databaseFailure("receipt validation")
	}
	return &receipt, nil
}

func (r *DatabaseRuntime) save(receipt *DatabaseReceipt) error {
	if err := os.MkdirAll(r.Dir, 0700); err != nil {
		return databaseFailure("receipt directory")
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return databaseFailure("receipt encoding")
	}
	file, err := os.CreateTemp(r.Dir, ".database-receipt-*")
	if err != nil {
		return databaseFailure("receipt write")
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil || os.Rename(file.Name(), filepath.Join(r.Dir, receipt.Identity.ID+".json")) != nil {
		return databaseFailure("receipt commit")
	}
	return nil
}

// Apply serializes lifecycle transitions. An uncertain operation can only be resumed with its original ID and input.
func (r *DatabaseRuntime) Apply(ctx context.Context, operation DatabaseOperation) (*DatabaseReceipt, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	identity := operation.Identity
	if r.Docker == nil || r.Dir == "" || !identity.valid() || identity.NodeID != r.NodeID || identity.FleetID != r.FleetID || !databaseUUID.MatchString(operation.ID) {
		return nil, databaseFailure("operation scope validation")
	}
	if operation.Action != "provision" && operation.Action != "start" && operation.Action != "stop" && operation.Action != "restart" && operation.Action != "delete" && operation.Action != "restore" {
		return nil, databaseFailure("operation action validation")
	}
	if len(operation.Containers) > 2 {
		return nil, databaseFailure("operation container validation")
	}
	roles := map[string]bool{}
	for _, spec := range operation.Containers {
		if spec.Identity != identity || (spec.Container.Role != "database" && spec.Container.Role != "pooler") || roles[spec.Container.Role] {
			return nil, databaseFailure("operation container scope")
		}
		roles[spec.Container.Role] = true
	}
	if operation.Action == "provision" && (!roles["database"] || operation.Readiness == nil) {
		return nil, databaseFailure("provision plan validation")
	}
	if operation.Action == "restore" && (!roles["database"] || operation.Readiness == nil || operation.Restore == nil) {
		return nil, databaseFailure("restore plan validation")
	}
	if operation.Action == "restore" {
		if _, err := validateDatabaseRestore(operation); err != nil {
			return nil, err
		}
	}
	data, _ := json.Marshal(operation)
	hash := sha256.Sum256(data)
	fingerprint := hex.EncodeToString(hash[:])
	receipt, err := r.read(identity.ID)
	if err != nil {
		return nil, err
	}
	if receipt != nil {
		// A new generation needs an explicit fenced recovery workflow; an operation cannot silently relabel an old primary.
		if receipt.Identity != identity {
			return nil, databaseFailure("generation or identity fencing")
		}
		if receipt.OperationID == operation.ID {
			if receipt.Fingerprint != fingerprint {
				return nil, databaseFailure("operation input changed")
			}
			if receipt.Phase == "rolled-back" {
				return nil, databaseFailure("restore failed; previous data was restored")
			}
			if receipt.Complete {
				return receipt, nil
			}
		} else {
			if !receipt.Complete && receipt.Phase != "rolled-back" {
				return nil, databaseFailure("previous operation requires reconciliation")
			}
			if operation.Action == "provision" {
				return nil, databaseFailure("database already provisioned")
			}
			receipt.OperationID, receipt.Action, receipt.Fingerprint = operation.ID, operation.Action, fingerprint
			receipt.Phase, receipt.Complete = "prepare", false
		}
	} else {
		if operation.Action != "provision" {
			return nil, databaseFailure("database receipt missing; reconcile explicitly")
		}
		receipt = &DatabaseReceipt{Identity: identity, OperationID: operation.ID, Action: operation.Action, Fingerprint: fingerprint, Phase: "prepare", Roles: []string{"database"}}
		if roles["pooler"] {
			receipt.Roles = append(receipt.Roles, "pooler")
		}
	}
	if err := r.save(receipt); err != nil {
		return nil, err
	}
	if operation.Action == "stop" || operation.Action == "restart" || operation.Action == "restore" {
		if receipt.Phase == "prepare" {
			for i := len(receipt.Roles) - 1; i >= 0; i-- {
				if err := r.Docker.StopDatabaseContainer(ctx, identity, receipt.Roles[i]); err != nil {
					return nil, err
				}
			}
			receipt.Phase = "stopped"
			if err := r.save(receipt); err != nil {
				return nil, err
			}
		}
		if operation.Action == "stop" {
			receipt.Complete = true
			return receipt, r.save(receipt)
		}
	}
	if operation.Action == "restore" && receipt.Phase == "stopped" {
		if err := r.Docker.RestoreDatabaseVolume(ctx, operation); err != nil {
			if r.rollbackAndResume(ctx, operation, receipt) == nil {
				return nil, databaseFailure("restore failed; previous data was restored")
			}
			return nil, err
		}
		for _, spec := range operation.Containers {
			if spec.Container.Role != "database" {
				continue
			}
			spec.Container.Env = operation.Restore.Env
			spec.Container.Files = operation.Restore.Files
			if operation.Restore.Kind == "redis-rdb" {
				spec.Container.Command = append(spec.Container.Command, "--appendonly", "no")
			}
			if err := r.Docker.ReconfigureDatabaseContainer(ctx, spec); err != nil {
				if r.rollbackAndResume(ctx, operation, receipt) == nil {
					return nil, databaseFailure("restore failed; previous data was restored")
				}
				return nil, err
			}
		}
		receipt.Phase = "restored"
		if err := r.save(receipt); err != nil {
			return nil, err
		}
	}
	if operation.Action == "delete" {
		if receipt.Phase == "prepare" {
			for i := len(operation.Containers) - 1; i >= 0; i-- {
				if err := r.Docker.RemoveDatabaseContainer(ctx, operation.Containers[i]); err != nil {
					return nil, err
				}
			}
			receipt.Phase, receipt.Complete = "stopped", true
			return receipt, r.save(receipt)
		}
	}
	if operation.Action == "provision" && !receipt.Initialized {
		if len(operation.Images) > 0 {
			if operation.ReserveBytes < 1<<30 {
				return nil, databaseFailure("image reserve validation")
			}
			budget, err := capability.ProbeDisk(ctx, r.Dir, operation.ReserveBytes, "")
			if err != nil {
				return nil, databaseFailure("image disk preflight")
			}
			if err := r.Docker.PrepullDatabaseImages(ctx, operation.Images, operation.RegistryAuth, budget, nil); err != nil {
				return nil, err
			}
		}

		for _, spec := range operation.Containers {
			if _, err := r.Docker.EnsureDatabaseContainer(ctx, spec); err != nil {
				return nil, err
			}
		}
		receipt.Initialized, receipt.Phase = true, "created"
		if err := r.save(receipt); err != nil {
			return nil, err
		}
	}
	if operation.Action == "start" || operation.Action == "restart" {
		for _, spec := range operation.Containers {
			if err := r.Docker.ReconfigureDatabaseContainer(ctx, spec); err != nil {
				return nil, err
			}
		}
	}
	for _, role := range receipt.Roles {
		name := DatabaseContainerName(identity.ID, role)
		state, err := r.Docker.Inspect(ctx, name)
		if err != nil || !ownedDatabase(state.Labels, identity, role, true) {
			return nil, databaseFailure("start ownership check; no replacement volume was created")
		}
		if !state.Running {
			if r.Docker.Start(ctx, state.ID) != nil {
				return nil, databaseFailure("start")
			}
		}
		if role == "database" {
			if operation.Readiness != nil {
				if err := r.ready(ctx, identity, *operation.Readiness); err != nil {
					if operation.Action == "restore" {
						if r.rollbackAndResume(ctx, operation, receipt) == nil {
							return nil, databaseFailure("restore readiness failed; previous data was restored")
						}
					}
					return nil, err
				}
			}
			if operation.Action == "restore" {
				for _, command := range operation.Restore.PostCommands {
					code, err := r.Docker.ExecDatabase(ctx, identity, "database", command, nil, io.Discard, io.Discard, false, time.Minute, nil)
					if err != nil || code != 0 {
						if r.rollbackAndResume(ctx, operation, receipt) == nil {
							return nil, databaseFailure("restore finalization failed; previous data was restored")
						}
						return nil, databaseFailure("restore finalization failed; reconciliation required")
					}
				}
				if len(operation.Restore.PostCommands) > 0 {
					if err := r.Docker.StopDatabaseContainer(ctx, identity, "database"); err != nil {
						return nil, err
					}
					for _, spec := range operation.Containers {
						if spec.Container.Role == "database" {
							if err := r.Docker.ReconfigureDatabaseContainer(ctx, spec); err != nil {
								if r.rollbackAndResume(ctx, operation, receipt) == nil {
									return nil, databaseFailure("restore finalization failed; previous data was restored")
								}
								return nil, err
							}
						}
					}
					state, err := r.Docker.Inspect(ctx, name)
					if err != nil || r.Docker.Start(ctx, state.ID) != nil {
						if r.rollbackAndResume(ctx, operation, receipt) == nil {
							return nil, databaseFailure("restore finalization failed; previous data was restored")
						}
						return nil, databaseFailure("restore finalization failed; reconciliation required")
					}
					if operation.Restore.FinalReadiness != nil {
						if err := r.ready(ctx, identity, *operation.Restore.FinalReadiness); err != nil {
							if r.rollbackAndResume(ctx, operation, receipt) == nil {
								return nil, databaseFailure("restore finalization failed; previous data was restored")
							}
							return nil, err
						}
					}
				}
				_ = r.Docker.CommitDatabaseRestore(ctx, operation)
			}
			if operation.Action == "provision" && !receipt.Bootstrapped {
				if operation.Bootstrap != nil {
					code, err := r.Docker.ExecDatabase(ctx, identity, "database", *operation.Bootstrap, nil, io.Discard, io.Discard, false, time.Minute, nil)
					if err != nil || code != 0 {
						return nil, databaseFailure("bootstrap")
					}
				}
				receipt.Bootstrapped = true
				if err := r.save(receipt); err != nil {
					return nil, err
				}
			}
		}
	}
	receipt.Phase, receipt.Complete = "running", true
	return receipt, r.save(receipt)
}

func (r *DatabaseRuntime) rollbackAndResume(ctx context.Context, operation DatabaseOperation, receipt *DatabaseReceipt) error {
	identity := operation.Identity
	_ = r.Docker.StopDatabaseContainer(ctx, identity, "database")
	if err := r.Docker.RollbackDatabaseRestore(ctx, operation); err != nil {
		return err
	}
	for _, spec := range operation.Containers {
		if spec.Container.Role == "database" {
			if err := r.Docker.ReconfigureDatabaseContainer(ctx, spec); err != nil {
				return err
			}
		}
	}
	for _, role := range receipt.Roles {
		name := DatabaseContainerName(identity.ID, role)
		state, err := r.Docker.Inspect(ctx, name)
		if err != nil || !ownedDatabase(state.Labels, identity, role, true) {
			return databaseFailure("restore rollback container ownership")
		}
		if !state.Running && r.Docker.Start(ctx, state.ID) != nil {
			return databaseFailure("restore rollback start")
		}
		if role == "database" && operation.Restore.FinalReadiness != nil {
			if err := r.ready(ctx, identity, *operation.Restore.FinalReadiness); err != nil {
				return databaseFailure("restore rollback readiness")
			}
		} else if role == "database" && operation.Readiness != nil {
			if err := r.ready(ctx, identity, *operation.Readiness); err != nil {
				return databaseFailure("restore rollback readiness")
			}
		}
	}
	receipt.Phase = "rolled-back"
	_ = r.save(receipt)
	return nil
}

func (r *DatabaseRuntime) ready(ctx context.Context, identity DatabaseIdentity, command DatabaseCommand) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	for {
		code, err := r.Docker.ExecDatabase(ctx, identity, "database", command, nil, io.Discard, io.Discard, false, 5*time.Second, nil)
		if err == nil && code == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return databaseFailure("readiness timeout")
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// CheckIdentity refuses access when local generation receipts cannot confirm ownership.
func (r *DatabaseRuntime) CheckIdentity(identity DatabaseIdentity) error {
	if !identity.valid() || identity.NodeID != r.NodeID || identity.FleetID != r.FleetID {
		return databaseFailure("session scope")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	receipt, err := r.read(identity.ID)
	if err != nil || receipt == nil || receipt.Identity != identity || !receipt.Initialized {
		return databaseFailure("session receipt or generation")
	}
	return nil
}
