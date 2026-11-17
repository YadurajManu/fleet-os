package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func runtimeFixture(t *testing.T) (*DatabaseRuntime, DatabaseOperation) {
	t.Helper()
	identity := databaseTestSpec().Identity
	return &DatabaseRuntime{Docker: New(""), NodeID: identity.NodeID, FleetID: identity.FleetID, Dir: t.TempDir()}, DatabaseOperation{ID: "dddddddd-1111-4444-8888-dddddddddddd", Action: "restart", Identity: identity}
}
func seedReceipt(t *testing.T, runtime *DatabaseRuntime, operation DatabaseOperation, phase string) {
	t.Helper()
	data, _ := json.Marshal(operation)
	hash := sha256.Sum256(data)
	if err := runtime.save(&DatabaseReceipt{Identity: operation.Identity, OperationID: operation.ID, Action: operation.Action, Fingerprint: hex.EncodeToString(hash[:]), Phase: phase, Roles: []string{"database"}, Initialized: true, Bootstrapped: true}); err != nil {
		t.Fatal(err)
	}
}

func TestDatabaseRuntimeRestartResumesAfterCleanStop(t *testing.T) {
	runtime, operation := runtimeFixture(t)
	seedReceipt(t, runtime, operation, "stopped")
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "database-container", "Config": map[string]any{"Labels": databaseLabels(operation.Identity, "database")}, "State": map[string]any{"Running": false}})
		} else if strings.HasSuffix(r.URL.Path, "/start") {
			w.WriteHeader(204)
		} else {
			t.Error("restart repeated stop or created resources", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	runtime.Docker = &Client{http: &http.Client{Transport: digestTestTransport{target: target}}, apiVersion: "v1.44"}
	receipt, err := runtime.Apply(t.Context(), operation)
	if err != nil || !receipt.Complete || receipt.Phase != "running" {
		t.Fatal("restart failed", err)
	}
	before := len(calls)
	// A new process reads the receipt and acknowledges the same operation without repeating any Docker calls.
	restarted := &DatabaseRuntime{Docker: runtime.Docker, NodeID: runtime.NodeID, FleetID: runtime.FleetID, Dir: runtime.Dir}
	if _, err := restarted.Apply(t.Context(), operation); err != nil || len(calls) != before {
		t.Fatal("completed restart replayed", err)
	}
	changed := operation
	changed.Action = "stop"
	if _, err := restarted.Apply(t.Context(), changed); err == nil {
		t.Fatal("idempotency input changed")
	}
	changed = operation
	changed.Identity.Generation++
	if _, err := restarted.Apply(t.Context(), changed); err == nil {
		t.Fatal("generation changed without fencing")
	}
}

func TestDatabaseRuntimeReceiptProtectsInputsAndPendingWork(t *testing.T) {
	runtime, operation := runtimeFixture(t)
	operation.Bootstrap = &DatabaseCommand{Command: []string{"psql"}, Stdin: "sensitive SQL", Env: map[string]string{"PGPASSWORD": "sensitive password"}}
	seedReceipt(t, runtime, operation, "created")
	data, err := os.ReadFile(filepath.Join(runtime.Dir, operation.Identity.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "sensitive") {
		t.Fatal("receipt persisted private input")
	}
	info, _ := os.Stat(filepath.Join(runtime.Dir, operation.Identity.ID+".json"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("receipt is not private")
	}
	other := operation
	other.ID = "eeeeeeee-1111-4444-8888-eeeeeeeeeeee"
	if _, err := runtime.Apply(t.Context(), other); err == nil {
		t.Fatal("pending operation overwritten")
	}
	other = operation
	other.Identity.NodeID = "ffffffff-1111-4444-8888-ffffffffffff"
	if _, err := runtime.Apply(t.Context(), other); err == nil {
		t.Fatal("cross-node operation accepted")
	}
	if err := os.WriteFile(filepath.Join(runtime.Dir, operation.Identity.ID+".json"), []byte("truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Apply(context.Background(), operation); err == nil {
		t.Fatal("corrupt receipt treated as new database")
	}
}

func TestDatabaseRestoreRejectsUnsafeTargetsBeforeStoppingDatabase(t *testing.T) {
	tests := []struct {
		name    string
		restore DatabaseRestore
	}{
		{name: "backup name injection", restore: DatabaseRestore{BackupName: "base_good;touch /tmp/pwned"}},
		{name: "timestamp injection", restore: DatabaseRestore{BackupName: "base_good", TargetTime: "2026-01-01T00:00:00Z'; touch /tmp/pwned; '"}},
		{name: "conflicting targets", restore: DatabaseRestore{BackupName: "base_good", TargetTime: "2026-01-01T00:00:00Z", TargetName: "before_migration"}},
		{name: "environment injection", restore: DatabaseRestore{BackupName: "base_good", Env: map[string]string{"bad-key": "value"}}},
		{name: "config traversal", restore: DatabaseRestore{BackupName: "base_good", Files: []DatabaseFile{{Path: "/etc/fleet/../../escape", Content: "x", Secret: true, Mode: 0600}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runtime, operation := runtimeFixture(t)
			operation.Action = "restore"
			spec := databaseTestSpec()
			spec.DataPath = "/var/lib/postgresql/data"
			operation.Containers = []DatabaseContainerSpec{spec}
			operation.Readiness = &DatabaseCommand{Command: []string{"pg_isready"}}
			operation.Restore = &tt.restore
			if _, err := runtime.Apply(t.Context(), operation); err == nil {
				t.Fatal("unsafe restore plan accepted")
			}
			if receipt, err := runtime.read(operation.Identity.ID); err != nil || receipt != nil {
				t.Fatal("invalid restore stopped or persisted the database", err)
			}
		})
	}
	spec := databaseTestSpec()
	spec.DataPath = "/var/lib/postgresql/data"
	operation := DatabaseOperation{
		ID:         "dddddddd-1111-4444-8888-dddddddddddd",
		Action:     "restore",
		Identity:   spec.Identity,
		Containers: []DatabaseContainerSpec{spec},
		Readiness:  &DatabaseCommand{Command: []string{"psql"}},
		Restore: &DatabaseRestore{
			BackupName: "base_000000010000000000000002",
			TargetName: "before_migration",
			Env:        map[string]string{"AWS_ENDPOINT": "https://s3.example.test"},
			Files:      []DatabaseFile{{Path: "/etc/fleet/walg-key", Content: "encrypted-key", Secret: true, Mode: 0600}},
		},
	}
	if _, err := validateDatabaseRestore(operation); err != nil {
		t.Fatal("valid point-in-time restore plan rejected", err)
	}
}
