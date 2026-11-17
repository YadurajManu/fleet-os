package docker

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func databaseTestSpec() DatabaseContainerSpec {
	i := DatabaseIdentity{ID: "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa", NodeID: "bbbbbbbb-1111-4444-8888-bbbbbbbbbbbb", FleetID: "cccccccc-1111-4444-8888-cccccccccccc", Project: "test", Generation: 1}
	return DatabaseContainerSpec{Identity: i, Initialize: true, Network: DatabaseNetworkName(i.FleetID, i.Project), Volume: "fleet-db-" + i.ID + "-data", DataPath: "/data", Platform: "linux/arm64", CPU: 0.5, Container: DatabaseContainer{Role: "database", Image: "sha256:" + strings.Repeat("a", 64), Command: []string{"redis-server", "/etc/fleet/redis.conf"}, MemoryMB: 256, Files: []DatabaseFile{{Path: "/etc/fleet/users.acl", Content: "protected-test-content", Secret: true, Mode: 0600}}, Aliases: []string{"test.fleet.internal"}}}
}

func TestDatabaseConfigArchiveRefusesTraversalAndWorldReadableSecrets(t *testing.T) {
	if _, err := databaseFiles([]DatabaseFile{{Path: "/etc/fleet/../../escape", Content: "secret", Secret: true, Mode: 0600}}); err == nil {
		t.Fatal("accepted path traversal")
	}
	if _, err := databaseFiles([]DatabaseFile{{Path: "/etc/fleet/secret", Content: "secret", Secret: true, Mode: 0644}}); err == nil {
		t.Fatal("accepted world-readable credentials")
	}
	data, err := databaseFiles(databaseTestSpec().Container.Files)
	if err != nil {
		t.Fatal(err)
	}
	r := tar.NewReader(bytes.NewReader(data))
	_, _ = r.Next()
	h, err := r.Next()
	if err != nil || h.Mode != 0600 || h.Uid != 999 || h.Gid != 999 || h.Name != "etc/fleet/users.acl" {
		t.Fatal("configuration ownership or path lost")
	}
}

func TestDatabaseCreateIsPrivateOwnedAndIdempotent(t *testing.T) {
	spec := databaseTestSpec()
	volumes := map[string]map[string]string{}
	containers := map[string]map[string]string{}
	network := false
	creates := 0
	archives := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/v1.44/")
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(p, "containers/"):
			name := strings.TrimSuffix(strings.TrimPrefix(p, "containers/"), "/json")
			labels, ok := containers[name]
			if !ok {
				http.Error(w, `{"message":"missing"}`, 404)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": name, "Config": map[string]any{"Labels": labels}})
		case r.Method == http.MethodGet && strings.HasPrefix(p, "volumes/"):
			labels, ok := volumes[strings.TrimPrefix(p, "volumes/")]
			if !ok {
				http.Error(w, `{"message":"missing"}`, 404)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Labels": labels})
		case p == "volumes/create":
			var b struct {
				Name   string
				Labels map[string]string
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			volumes[b.Name] = b.Labels
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodGet && strings.HasPrefix(p, "networks/"):
			if !network {
				http.Error(w, `{"message":"missing"}`, 404)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Labels": map[string]string{"io.fleet.database-fleet": spec.Identity.FleetID, "io.fleet.database-project": spec.Network}})
		case p == "networks/create":
			network = true
			_, _ = w.Write([]byte(`{}`))
		case p == "containers/create":
			if r.URL.Query().Get("platform") != spec.Platform {
				t.Error("configuration writer or database lost its execution platform")
			}
			var b struct {
				Labels     map[string]string
				HostConfig struct {
					PortBindings map[string]any
					Memory       int64
					NanoCPUs     int64
					Mounts       []mount
				}
				StopSignal string
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			name := r.URL.Query().Get("name")
			containers[name] = b.Labels
			creates++
			if b.Labels[LabelManaged] != "" || len(b.HostConfig.PortBindings) != 0 {
				t.Error("database leaked into app reconciliation or host ports")
			}
			if b.Labels[DatabaseRoleLabel] == "database" && (b.HostConfig.Memory != 256<<20 || b.HostConfig.NanoCPUs != 500000000 || b.StopSignal != "SIGTERM") {
				t.Error("database limits/shutdown signal lost")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"Id": name})
		case r.Method == http.MethodPut && strings.HasSuffix(p, "/archive"):
			archives++
			body, _ := io.ReadAll(r.Body)
			if !bytes.Contains(body, []byte("protected-test-content")) {
				t.Error("config not delivered")
			}
		case r.Method == http.MethodDelete:
			delete(containers, strings.TrimPrefix(p, "containers/"))
		default:
			t.Errorf("unexpected request %s %s", r.Method, p)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	first, err := c.EnsureDatabaseContainer(t.Context(), spec)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.EnsureDatabaseContainer(t.Context(), spec)
	if err != nil || first != second || creates != 2 || archives != 1 {
		t.Fatal("retry recreated existing state")
	}
	spec.Identity.Generation = 2
	if _, err := c.EnsureDatabaseContainer(t.Context(), spec); err == nil {
		t.Fatal("changed generation silently replaced existing state")
	}
	if creates != 2 {
		t.Fatal("rejected generation mutated containers")
	}
}

func TestDatabaseMissingDataNeverInitializesWithoutExplicitCreate(t *testing.T) {
	spec := databaseTestSpec()
	spec.Initialize = false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("missing data volume was created without authorization")
		}
		http.Error(w, `{"message":"missing"}`, 404)
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	if err := c.ensureDatabaseVolume(t.Context(), spec.Volume, spec.Identity, "data", false); err == nil {
		t.Fatal("missing data accepted as empty database")
	}
}

func TestDatabaseStopNeverEscalatesToKill(t *testing.T) {
	spec := databaseTestSpec()
	stopped := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": databaseLabels(spec.Identity, "database")}, "State": map[string]bool{"Running": true}})
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/stop") || r.URL.Query().Get("t") != "-1" {
			t.Error("clean database stop can escalate to kill")
		}
		stopped = true
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	if err := c.StopDatabaseContainer(t.Context(), spec.Identity, "database"); err != nil || !stopped {
		t.Fatal("clean shutdown not requested")
	}
}

func TestDatabaseDeleteRemovesOwnedContainerAndConfigButPreservesData(t *testing.T) {
	spec := databaseTestSpec()
	configHash := databaseContainerConfigHash(spec)
	containerName := DatabaseContainerName(spec.Identity.ID, "database")
	configVolume := spec.Volume + "-database-config-" + configHash[:12]
	volumes := map[string]map[string]string{
		spec.Volume:                    databaseLabels(spec.Identity, "data"),
		configVolume:                   databaseLabels(spec.Identity, "config-database"),
		spec.Volume + "-pooler-config": databaseLabels(spec.Identity, "config-pooler"),
	}
	labels := databaseLabels(spec.Identity, "database")
	labels[databaseConfigLabel] = configHash
	running := true
	containerPresent := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/v1.44/")
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(p, "containers/"):
			if !containerPresent {
				http.Error(w, `{"message":"missing"}`, http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Id":     containerName,
				"Config": map[string]any{"Labels": labels},
				"State":  map[string]bool{"Running": running},
			})
		case r.Method == http.MethodGet && strings.HasPrefix(p, "volumes/"):
			volumeLabels, ok := volumes[strings.TrimPrefix(p, "volumes/")]
			if !ok {
				http.Error(w, `{"message":"missing"}`, http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Labels": volumeLabels})
		case r.Method == http.MethodPost && strings.HasSuffix(p, "/stop"):
			running = false
		case r.Method == http.MethodDelete && strings.HasPrefix(p, "containers/"):
			if r.URL.Query().Get("v") != "false" {
				t.Fatal("delete removed container volumes")
			}
			containerPresent = false
		case r.Method == http.MethodDelete && strings.HasPrefix(p, "volumes/"):
			name := strings.TrimPrefix(p, "volumes/")
			if name == spec.Volume {
				t.Fatal("delete removed the database data volume")
			}
			delete(volumes, name)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	if err := c.RemoveDatabaseContainer(t.Context(), spec); err != nil {
		t.Fatal(err)
	}
	if containerPresent || running {
		t.Fatal("owned database container remained after delete")
	}
	if _, ok := volumes[spec.Volume]; !ok {
		t.Fatal("database data volume was removed")
	}
	if _, ok := volumes[configVolume]; ok {
		t.Fatal("owned config volume was not removed")
	}
}
