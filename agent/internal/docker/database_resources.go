package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const DatabaseLabel = "io.fleet.database"
const DatabaseNodeLabel = "io.fleet.database-node"
const DatabaseRoleLabel = "io.fleet.database-role"
const DatabaseGenerationLabel = "io.fleet.database-generation"
const databaseConfigLabel = "io.fleet.database-config"

var databaseUUID = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
var databaseConfigName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

type DatabaseIdentity struct {
	ID         string `json:"id"`
	NodeID     string `json:"nodeId"`
	FleetID    string `json:"fleetId"`
	Project    string `json:"project"`
	Generation int    `json:"generation"`
}
type DatabaseFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Secret  bool   `json:"secret"`
	Mode    int64  `json:"mode"`
}
type DatabaseContainer struct {
	Role     string            `json:"role"`
	Image    string            `json:"image"`
	Command  []string          `json:"command"`
	Env      map[string]string `json:"env"`
	Files    []DatabaseFile    `json:"files"`
	Aliases  []string          `json:"aliases"`
	MemoryMB int64             `json:"memoryMb"`
	Port     int               `json:"port"`
}
type DatabaseContainerSpec struct {
	Initialize bool              `json:"initialize"`
	Identity   DatabaseIdentity  `json:"identity"`
	Network    string            `json:"network"`
	Volume     string            `json:"volume"`
	DataPath   string            `json:"dataPath"`
	Platform   string            `json:"platform"`
	CPU        float64           `json:"cpu"`
	Container  DatabaseContainer `json:"container"`
}

func DatabaseContainerName(id, role string) string { return "fleet-db-" + id + "-" + role }
func DatabaseNetworkName(fleetID, project string) string {
	hash := sha256.Sum256([]byte(fleetID + "\x00" + project))
	return "fleet-db-" + hex.EncodeToString(hash[:])[:24]
}
func (identity DatabaseIdentity) valid() bool {
	return databaseUUID.MatchString(identity.ID) && databaseUUID.MatchString(identity.NodeID) && databaseUUID.MatchString(identity.FleetID) && identity.Generation > 0 && len(identity.Project) > 0 && len(identity.Project) <= 512
}
func databaseLabels(identity DatabaseIdentity, role string) map[string]string {
	return map[string]string{DatabaseLabel: identity.ID, DatabaseNodeLabel: identity.NodeID, DatabaseRoleLabel: role, DatabaseGenerationLabel: strconv.Itoa(identity.Generation)}
}
func ownedDatabase(labels map[string]string, identity DatabaseIdentity, role string, generation bool) bool {
	return labels[DatabaseLabel] == identity.ID && labels[DatabaseNodeLabel] == identity.NodeID && labels[DatabaseRoleLabel] == role && (!generation || labels[DatabaseGenerationLabel] == strconv.Itoa(identity.Generation))
}
func databaseFailure(action string) error {
	return fmt.Errorf("database %s failed; inspect the operation and Docker availability before retrying", action)
}

func (c *Client) ensureDatabaseVolume(ctx context.Context, name string, identity DatabaseIdentity, role string, initialize bool) error {
	var volume struct {
		Labels map[string]string `json:"Labels"`
	}
	err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/volumes/"+url.PathEscape(name), nil, &volume)
	if IsNotFound(err) {
		if !initialize {
			return databaseFailure("data volume is missing; restore or recover explicitly")
		}
		if c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/volumes/create", map[string]any{"Name": name, "Labels": databaseLabels(identity, role)}, nil) != nil {
			return databaseFailure("volume creation")
		}
		err = c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/volumes/"+url.PathEscape(name), nil, &volume)
	}
	if err != nil || !ownedDatabase(volume.Labels, identity, role, false) {
		return databaseFailure("volume ownership check")
	}
	return nil
}

func (c *Client) ensureDatabaseNetwork(ctx context.Context, identity DatabaseIdentity, name string) error {
	labels := map[string]string{"io.fleet.database-fleet": identity.FleetID, "io.fleet.database-project": name}
	var network struct {
		Labels map[string]string `json:"Labels"`
	}
	err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/networks/"+name, nil, &network)
	if IsNotFound(err) {
		err = c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/networks/create", map[string]any{"Name": name, "Driver": "bridge", "CheckDuplicate": true, "Labels": labels}, nil)
		if err != nil && !isAlreadyExists(err) {
			return databaseFailure("project network creation")
		}
		err = c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/networks/"+name, nil, &network)
	}
	if err != nil || network.Labels["io.fleet.database-fleet"] != identity.FleetID || network.Labels["io.fleet.database-project"] != name {
		return databaseFailure("project network ownership check")
	}
	return nil
}

func databaseFiles(files []DatabaseFile) ([]byte, error) {
	if len(files) > 16 {
		return nil, databaseFailure("configuration validation")
	}
	var archive bytes.Buffer
	w := tar.NewWriter(&archive)
	if err := w.WriteHeader(&tar.Header{Name: "etc/fleet", Typeflag: tar.TypeDir, Mode: 0700, Uid: 999, Gid: 999}); err != nil {
		return nil, err
	}
	total := 0
	seen := map[string]bool{}
	for _, file := range files {
		base := path.Base(file.Path)
		total += len(file.Content)
		if file.Path != "/etc/fleet/"+base || !databaseConfigName.MatchString(base) || seen[base] || total > 262144 || (file.Secret && file.Mode != 0600) || (!file.Secret && file.Mode != 0644) {
			return nil, databaseFailure("configuration validation")
		}
		seen[base] = true
		if err := w.WriteHeader(&tar.Header{Name: "etc/fleet/" + base, Typeflag: tar.TypeReg, Mode: file.Mode, Uid: 999, Gid: 999, Size: int64(len(file.Content))}); err != nil {
			return nil, err
		}
		if _, err := io.WriteString(w, file.Content); err != nil {
			return nil, err
		}
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return archive.Bytes(), nil
}

func databaseContainerConfigHash(spec DatabaseContainerSpec) string {
	fingerprint := spec
	fingerprint.Initialize = false
	encoded, _ := json.Marshal(fingerprint)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (c *Client) installDatabaseFiles(ctx context.Context, spec DatabaseContainerSpec, configVolume string, archive []byte) error {
	name := DatabaseContainerName(spec.Identity.ID, spec.Container.Role+"-config-writer")
	if existing, err := c.Inspect(ctx, name); err == nil {
		if existing.Running || !ownedDatabase(existing.Labels, spec.Identity, "config-writer", true) {
			return databaseFailure("configuration writer ownership check")
		}
		if c.Remove(ctx, name) != nil {
			return databaseFailure("configuration writer cleanup")
		}
	} else if !IsNotFound(err) {
		return databaseFailure("configuration writer inspection")
	}
	var created createResponse
	if c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/create?name="+name+"&platform="+url.QueryEscape(spec.Platform), map[string]any{
		"Image": spec.Container.Image, "User": "999:999", "Entrypoint": []string{"/bin/true"}, "Labels": databaseLabels(spec.Identity, "config-writer"),
		"HostConfig": map[string]any{"NetworkMode": "none", "Mounts": []mount{{Type: "volume", Source: configVolume, Target: "/etc/fleet"}}},
	}, &created) != nil {
		return databaseFailure("configuration writer creation")
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_ = c.Remove(cleanup, name)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://docker/"+c.api(ctx)+"/containers/"+created.ID+"/archive?path=/&copyUIDGID=true&noOverwriteDirNonDir=true", bytes.NewReader(archive))
	if err != nil {
		return databaseFailure("configuration upload")
	}
	req.Header.Set("Content-Type", "application/x-tar")
	response, err := c.http.Do(req)
	if err != nil {
		return databaseFailure("configuration upload")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return databaseFailure("configuration upload")
	}
	return nil
}

// EnsureDatabaseContainer never changes an existing container's generation or mounts a new empty data volume as recovery.
func (c *Client) EnsureDatabaseContainer(ctx context.Context, spec DatabaseContainerSpec) (string, error) {
	identity, container := spec.Identity, spec.Container
	if !identity.valid() || (container.Role != "database" && container.Role != "pooler") || spec.Network != DatabaseNetworkName(identity.FleetID, identity.Project) || !strings.HasPrefix(spec.Volume, "fleet-db-"+identity.ID+"-data") || len(spec.Volume) > 128 || !regexp.MustCompile(`^[a-z0-9-]+$`).MatchString(spec.Volume) || (spec.DataPath != "/data" && spec.DataPath != "/var/lib/postgresql/data") || (spec.Platform != "linux/arm64" && spec.Platform != "linux/amd64") || container.MemoryMB < 64 || container.MemoryMB > 1048576 || math.IsNaN(spec.CPU) || spec.CPU < 0.01 || spec.CPU > 1024 || len(container.Command) == 0 || len(container.Aliases) > 4 {
		return "", databaseFailure("runtime specification validation")
	}
	if !databaseImageReference.MatchString(container.Image) && !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(container.Image) {
		return "", databaseFailure("image pin validation")
	}
	archive, err := databaseFiles(container.Files)
	if err != nil {
		return "", err
	}
	configHash := databaseContainerConfigHash(spec)
	name := DatabaseContainerName(identity.ID, container.Role)
	if existing, err := c.Inspect(ctx, name); err == nil {
		if !ownedDatabase(existing.Labels, identity, container.Role, true) || existing.Labels[databaseConfigLabel] != configHash {
			return "", databaseFailure("existing configuration check; use an explicit restart or recovery")
		}
		return existing.ID, nil
	} else if !IsNotFound(err) {
		return "", databaseFailure("container inspection")
	}
	if err := c.ensureDatabaseNetwork(ctx, identity, spec.Network); err != nil {
		return "", err
	}
	configVolume := spec.Volume + "-" + container.Role + "-config-" + configHash[:12]
	if err := c.ensureDatabaseVolume(ctx, configVolume, identity, "config-"+container.Role, true); err != nil {
		return "", err
	}
	if err := c.installDatabaseFiles(ctx, spec, configVolume, archive); err != nil {
		return "", err
	}
	mounts := []mount{{Type: "volume", Source: configVolume, Target: "/etc/fleet", ReadOnly: true}}
	if container.Role == "database" {
		if err := c.ensureDatabaseVolume(ctx, spec.Volume, identity, "data", spec.Initialize); err != nil {
			return "", err
		}
		mounts = append(mounts, mount{Type: "volume", Source: spec.Volume, Target: spec.DataPath})
	}
	keys := make([]string, 0, len(container.Env))
	for key := range container.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		env = append(env, key+"="+container.Env[key])
	}
	labels := databaseLabels(identity, container.Role)
	labels[databaseConfigLabel] = configHash
	signal := "SIGTERM"
	if spec.DataPath == "/var/lib/postgresql/data" && container.Role == "database" {
		signal = "SIGINT"
	}
	var created createResponse
	if c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/create?name="+name+"&platform="+url.QueryEscape(spec.Platform), map[string]any{
		"Image": container.Image, "Cmd": container.Command, "Env": env, "Labels": labels, "StopSignal": signal,
		"HostConfig":       map[string]any{"NetworkMode": spec.Network, "Mounts": mounts, "Memory": container.MemoryMB << 20, "NanoCpus": int64(spec.CPU * 1e9), "RestartPolicy": map[string]string{"Name": "unless-stopped"}},
		"NetworkingConfig": networkingConfig{EndpointsConfig: map[string]endpointConfig{spec.Network: {Aliases: container.Aliases}}},
	}, &created) != nil {
		return "", databaseFailure("container creation")
	}
	return created.ID, nil
}

// ReconfigureDatabaseContainer only replaces an owned stopped container; its data volume is preserved.
func (c *Client) ReconfigureDatabaseContainer(ctx context.Context, spec DatabaseContainerSpec) error {
	name := DatabaseContainerName(spec.Identity.ID, spec.Container.Role)
	state, err := c.Inspect(ctx, name)
	if IsNotFound(err) {
		_, err = c.EnsureDatabaseContainer(ctx, spec)
		return err
	}
	if err != nil || !ownedDatabase(state.Labels, spec.Identity, spec.Container.Role, true) || state.Running {
		return databaseFailure("reconfiguration ownership or stopped-state check")
	}
	configHash := databaseContainerConfigHash(spec)
	oldHash := state.Labels[databaseConfigLabel]
	if oldHash == configHash {
		return nil
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(oldHash) {
		return databaseFailure("old container configuration identity check")
	}
	if c.Remove(ctx, state.ID) != nil {
		return databaseFailure("old container removal for reconfiguration")
	}
	for _, oldVolume := range []string{
		spec.Volume + "-" + spec.Container.Role + "-config-" + oldHash[:12],
		spec.Volume + "-" + spec.Container.Role + "-config",
	} {
		if err := c.removeDatabaseConfigVolume(ctx, oldVolume, spec.Identity, spec.Container.Role); err != nil {
			return err
		}
	}
	_, err = c.EnsureDatabaseContainer(ctx, spec)
	return err
}

func (c *Client) removeDatabaseConfigVolume(ctx context.Context, name string, identity DatabaseIdentity, role string) error {
	var volume struct {
		Labels map[string]string `json:"Labels"`
	}
	err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/volumes/"+url.PathEscape(name), nil, &volume)
	if IsNotFound(err) {
		return nil
	}
	if err != nil || !ownedDatabase(volume.Labels, identity, "config-"+role, false) {
		return databaseFailure("old configuration volume ownership check")
	}
	err = c.do(ctx, http.MethodDelete, "/"+c.api(ctx)+"/volumes/"+url.PathEscape(name), nil, nil)
	if err != nil && !IsNotFound(err) {
		return databaseFailure("old configuration volume cleanup")
	}
	return nil
}

// StopDatabaseContainer waits for a clean engine exit; unlike app Stop it never escalates to SIGKILL.
func (c *Client) StopDatabaseContainer(ctx context.Context, identity DatabaseIdentity, role string) error {
	if !identity.valid() || (role != "database" && role != "pooler") {
		return databaseFailure("stop validation")
	}
	name := DatabaseContainerName(identity.ID, role)
	state, err := c.Inspect(ctx, name)
	if IsNotFound(err) {
		return nil
	}
	if err != nil || !ownedDatabase(state.Labels, identity, role, true) {
		return databaseFailure("stop ownership check")
	}
	if !state.Running {
		return nil
	}
	if c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/"+name+"/stop?t=-1", nil, nil) != nil {
		return databaseFailure("clean shutdown")
	}
	return nil
}

// RemoveDatabaseContainer removes only an owned runtime container and its config volume; data and network volumes survive the grace period.
func (c *Client) RemoveDatabaseContainer(ctx context.Context, spec DatabaseContainerSpec) error {
	identity, role := spec.Identity, spec.Container.Role
	if !identity.valid() || (role != "database" && role != "pooler") || spec.Volume != "fleet-db-"+identity.ID+"-data" {
		return databaseFailure("delete validation")
	}
	name := DatabaseContainerName(identity.ID, role)
	state, err := c.Inspect(ctx, name)
	if err != nil && !IsNotFound(err) {
		return databaseFailure("delete ownership check")
	}
	if err == nil && !ownedDatabase(state.Labels, identity, role, true) {
		return databaseFailure("delete ownership check")
	}
	if err == nil && state.Running {
		if err := c.StopDatabaseContainer(ctx, identity, role); err != nil {
			return err
		}
	}
	if err == nil {
		if err := c.Remove(ctx, state.ID); err != nil && !IsNotFound(err) {
			return databaseFailure("container removal")
		}
	}
	configHash := ""
	if err == nil {
		configHash = state.Labels[databaseConfigLabel]
	}
	if regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(configHash) {
		if err := c.removeDatabaseConfigVolume(ctx, spec.Volume+"-"+role+"-config-"+configHash[:12], identity, role); err != nil {
			return err
		}
	}
	return c.removeDatabaseConfigVolume(ctx, spec.Volume+"-"+role+"-config", identity, role)
}
