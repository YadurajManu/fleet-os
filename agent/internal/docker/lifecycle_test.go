package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestSplitTag(t *testing.T) {
	cases := []struct {
		image, wantRef, wantTag string
	}{
		{"nginx", "nginx", "latest"},
		{"localhost:5001/web@sha256:" + strings.Repeat("a", 64), "localhost:5001/web", "sha256:" + strings.Repeat("a", 64)},
		// A bare library image pinned by digest must be qualified for Docker 28+ and split into ref + digest.
		{"postgres@sha256:" + strings.Repeat("b", 64), "docker.io/library/postgres", "sha256:" + strings.Repeat("b", 64)},
		{"nginx:1.27", "nginx", "1.27"},
		{"ghcr.io/you/app:v2", "ghcr.io/you/app", "v2"},
		// A registry port must not be mistaken for a tag — this is the case
		// that breaks naive splitting, and it is exactly what a self-hosted
		// registry looks like.
		{"localhost:5001/web", "localhost:5001/web", "latest"},
		{"localhost:5001/web:4f1c9ae", "localhost:5001/web", "4f1c9ae"},
	}
	for _, c := range cases {
		ref, tag := splitTag(c.image)
		if ref != c.wantRef || tag != c.wantTag {
			t.Errorf("splitTag(%q) = (%q, %q), want (%q, %q)", c.image, ref, tag, c.wantRef, c.wantTag)
		}
	}
}

func TestContainerNameIsDeterministic(t *testing.T) {
	// Reconciliation finds what it created by name after a restart, without
	// keeping its own index — so this must not drift.
	const dep = "4d09781f-8780-4b2a-9c31-000000000000"
	if got := ContainerName("img-proxy", dep); got != "fleet-img-proxy-4d09781f" {
		t.Errorf("ContainerName = %q, want fleet-img-proxy-4d09781f", got)
	}
	if ContainerName("web", dep) != ContainerName("web", dep) {
		t.Error("ContainerName is not stable")
	}
}

func TestContainerNameSeparatesDeployments(t *testing.T) {
	// The reason for the suffix: during a rollout the replacement is created
	// while the release it replaces is still serving, and two containers
	// cannot share a name.
	a := ContainerName("web", "aaaaaaaa-1111-4b2a-9c31-000000000000")
	b := ContainerName("web", "bbbbbbbb-2222-4b2a-9c31-000000000000")
	if a == b {
		t.Errorf("two deployments of one service produced the same name: %q", a)
	}
	// Still prefixed with fleet-, which is what `fleet unpair` filters on when
	// it cleans a machine up.
	for _, name := range []string{a, b} {
		if !strings.HasPrefix(name, "fleet-") {
			t.Errorf("%q lost the fleet- prefix that teardown relies on", name)
		}
	}
}

func TestContainerNameFallsBackWithoutADeployment(t *testing.T) {
	// Should still produce a usable name rather than a trailing hyphen.
	if got := ContainerName("web", ""); got != "fleet-web" {
		t.Errorf("ContainerName = %q, want fleet-web", got)
	}
}

func TestDemultiplexStripsStreamHeaders(t *testing.T) {
	// Docker frames log output as [stream, 0,0,0, size(4 bytes)] + payload.
	frame := func(payload string) []byte {
		n := len(payload)
		return append([]byte{1, 0, 0, 0, byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)}, payload...)
	}
	raw := append(frame("hello\n"), frame("world\n")...)
	if got := demultiplex(raw); got != "hello\nworld\n" {
		t.Errorf("demultiplex = %q, want %q", got, "hello\nworld\n")
	}
}

func TestDemultiplexPassesThroughUnframedOutput(t *testing.T) {
	// A TTY container writes raw bytes with no header; mangling that would
	// make logs unreadable for exactly the containers people run interactively.
	raw := []byte("plain tty output with no framing at all")
	if got := demultiplex(raw); got != string(raw) {
		t.Errorf("demultiplex mangled unframed output: %q", got)
	}
}

func TestIsNotFoundUnwraps(t *testing.T) {
	if !IsNotFound(&Error{StatusCode: 404}) {
		t.Error("404 should be reported as not found")
	}
	if IsNotFound(&Error{StatusCode: 500}) {
		t.Error("500 is a real failure, not a missing container")
	}
	if IsNotFound(nil) {
		t.Error("nil is not a not-found error")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// The case that matters: string comparison would put 1.9 above 1.44.
		{"1.9", "1.44", -1},
		{"1.44", "1.9", 1},
		{"1.44", "1.44", 0},
		{"1.43", "1.44", -1},
		{"1.51", "1.44", 1},
		{"1", "1.0", 0},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestPullPreservesDigestReference(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	image := "registry.example:5000/app@" + digest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("fromImage"); got != "registry.example:5000/app" {
			t.Errorf("fromImage = %q", got)
		}
		if got := r.URL.Query().Get("tag"); got != digest {
			t.Errorf("tag = %q, want %q", got, digest)
		}
		if got := r.URL.Query().Get("platform"); got != "linux/arm64" {
			t.Errorf("platform = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"Downloaded"}`))
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	client := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	if err := client.PullForPlatform(context.Background(), image, "", "linux/arm64", nil); err != nil {
		t.Fatal(err)
	}
}

func TestCreateAttachesDatabaseNetworkBeforeReturning(t *testing.T) {
	const network = "fleet-db-0123456789abcdef01234567"
	var connected bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1.44/containers/create":
			_, _ = w.Write([]byte(`{"Id":"container-id"}`))
		case r.URL.Path == "/v1.44/networks/"+network+"/connect":
			var request networkConnectRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if request.Container != "container-id" {
				t.Errorf("attached container = %q", request.Container)
			}
			connected = true
		default:
			t.Errorf("unexpected Docker request %s %s", r.Method, r.URL.Path)
			http.Error(w, "not found", http.StatusNotFound)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	client := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	id, err := client.Create(context.Background(), RunSpec{
		Service: "web", DeploymentID: "deployment-id", Image: "nginx:latest", Networks: []string{network},
	})
	if err != nil {
		t.Fatal(err)
	}
	if id != "container-id" || !connected {
		t.Fatalf("Create = %q, network connected = %t", id, connected)
	}
}

func TestCreateRejectsUntrustedAdditionalNetwork(t *testing.T) {
	client := &Client{}
	_, err := client.Create(context.Background(), RunSpec{Networks: []string{"fleet"}})
	if err == nil || !strings.Contains(err.Error(), "invalid database network") {
		t.Fatalf("Create error = %v, want invalid database network", err)
	}
}

func TestRealDockerDatabaseNetworkConnection(t *testing.T) {
	if os.Getenv("FLEET_DB_REAL_NETWORK_TEST") != "1" {
		t.Skip("set FLEET_DB_REAL_NETWORK_TEST=1 to run the Docker network acceptance test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(random[:])
	network := "fleet-db-" + suffix
	database := "fleet-db-target-" + suffix[:8]
	password := "test-only-" + suffix
	service := "fleet-db-client-" + suffix[:8]
	deployment := "01234567-89ab-4cde-8fab-" + suffix[:12]
	client := New("")
	if err := client.EnsureNetwork(ctx); err != nil {
		t.Fatal(err)
	}
	command := func(args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	}
	if output, err := command("network", "create", network); err != nil {
		t.Fatalf("create database network: %v: %s", err, output)
	}
	t.Cleanup(func() {
		_, _ = command("rm", "-f", ContainerName(service, deployment), database)
		_, _ = command("network", "rm", network)
	})
	if output, err := command("run", "-d", "--name", database, "--network", network, "--network-alias", "primary", "-e", "POSTGRES_PASSWORD="+password, "postgres:16-alpine"); err != nil {
		t.Fatalf("start database: %v: %s", err, output)
	}
	waitFor := func(args ...string) ([]byte, error) {
		var output []byte
		var err error
		for ctx.Err() == nil {
			output, err = command(args...)
			if err == nil {
				return output, nil
			}
			time.Sleep(250 * time.Millisecond)
		}
		return output, err
	}
	if output, err := waitFor("exec", database, "pg_isready", "-U", "postgres"); err != nil {
		t.Fatalf("wait for database: %v: %s", err, output)
	}
	id, err := client.Create(ctx, RunSpec{
		Service: service, DeploymentID: deployment, Image: "postgres:16-alpine",
		Env: map[string]string{"POSTGRES_PASSWORD": password}, Networks: []string{network},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	output, err := waitFor("exec", ContainerName(service, deployment), "pg_isready", "-h", "primary", "-U", "postgres")
	if err != nil {
		t.Fatalf("service could not reach the database on its private network: %v: %s", err, output)
	}
	output, err = command("exec", "-e", "PGPASSWORD="+password, ContainerName(service, deployment), "psql", "-h", "primary", "-U", "postgres", "-Atqc", "select current_database()")
	if err != nil || strings.TrimSpace(string(output)) != "postgres" {
		t.Fatalf("query over database network = %q, err = %v", output, err)
	}
}

type digestTestTransport struct{ target *url.URL }

func (d digestTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.URL.Scheme = d.target.Scheme
	r.URL.Host = d.target.Host
	return http.DefaultTransport.RoundTrip(r)
}
