package build

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"github.com/fleet-os/fleet-os/agent/internal/capability"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func archive(name string, kind byte) []byte {
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: name, Typeflag: kind, Mode: 0644, Size: 0, Linkname: "/tmp/escape"})
	_ = tw.Close()
	_ = gz.Close()
	return b.Bytes()
}

func TestFractionalCPUAssignmentValidation(t *testing.T) {
	e := New(t.TempDir(), capability.BuilderConfig{CPU: 2, MemoryBytes: 2 << 30, DiskBytes: 20 << 30}, func(Event) {})
	for _, millis := range []int{-1, 1, 2001} {
		_, err := e.execute(context.Background(), Assignment{CPU: 1, CPUMillis: millis, MemoryBytes: 256 << 20, DiskBytes: 1 << 30})
		if err == nil || !strings.Contains(err.Error(), "requested build limits") {
			t.Fatalf("invalid CPU %d accepted: %v", millis, err)
		}
	}
	_, err := e.execute(context.Background(), Assignment{CPU: 1, CPUMillis: 250, Platform: "invalid", MemoryBytes: 256 << 20, DiskBytes: 1 << 30})
	if err == nil || strings.Contains(err.Error(), "requested build limits") {
		t.Fatalf("fractional CPU rejected before platform validation: %v", err)
	}
}

func TestMemoryCeilingOnDockerExecutor(t *testing.T) {
	if os.Getenv("FLEET_DOCKER_INTEGRATION") != "1" {
		t.Skip("set FLEET_DOCKER_INTEGRATION=1 to check the real Docker-backed executor")
	}
	report, err := capability.DetectEngine(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, ceiling := range []int64{2 << 30, 3 << 30} {
		e := New(t.TempDir(), capability.BuilderConfig{CPU: 2, MemoryBytes: ceiling, DiskBytes: 20 << 30}, func(Event) {})
		a := Assignment{CPU: 1, MemoryBytes: ceiling, DiskBytes: 1 << 30, Platform: report.Platform}
		_, err = e.execute(context.Background(), a)
		if err == nil || !strings.Contains(err.Error(), "invalid registry target") {
			t.Fatalf("negotiated memory %d rejected before registry validation: %v", ceiling, err)
		}
		a.MemoryBytes++
		_, err = e.execute(context.Background(), a)
		if err == nil || !strings.Contains(err.Error(), "requested build limits") {
			t.Fatalf("over-ceiling assignment accepted: %v", err)
		}
	}
}
func TestExtractionRejectsTraversalAndLinks(t *testing.T) {
	for _, name := range []string{"../escape", "/tmp/escape", "C:/escape", "..\\escape"} {
		if extract(bytes.NewReader(archive(name, tar.TypeReg)), t.TempDir()) == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	if extract(bytes.NewReader(archive("link", tar.TypeSymlink)), t.TempDir()) == nil {
		t.Fatal("accepted symlink")
	}
}
func TestExtractRegular(t *testing.T) {
	dir := t.TempDir()
	if err := extract(bytes.NewReader(archive("src/Dockerfile", tar.TypeReg)), dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "src/Dockerfile")); err != nil {
		t.Fatal(err)
	}
}
func TestRedaction(t *testing.T) {
	a := Assignment{RegistryPassword: "registry-secret", Source: Source{URL: "https://secret-url"}, Secrets: map[string]string{"TOKEN": "build-secret"}}
	got := redact("registry-secret build-secret https://secret-url", a)
	if strings.Contains(got, "secret") {
		t.Fatal(got)
	}
}
func TestOptInAndDuplicateAssignment(t *testing.T) {
	events := []Event{}
	e := New(t.TempDir(), capability.BuilderConfig{}, func(ev Event) { events = append(events, ev) })
	a := Assignment{Type: "build.assign", Version: 1, JobID: "job", Attempt: 1, TimeoutMs: 1000}
	body, _ := json.Marshal(a)
	e.Handle(context.Background(), body)
	if len(events) != 1 || events[0].Status != "failed" {
		t.Fatal(events)
	}
	e.tasks[key("job", 1)] = &task{a: a, cancel: func() {}}
	e.Handle(context.Background(), body)
	if events[1].Type != "build.ack" {
		t.Fatal(events)
	}
}
func TestCancellationFencesAttempt(t *testing.T) {
	cancelled := false
	e := New(t.TempDir(), capability.BuilderConfig{}, func(Event) {})
	e.tasks[key("job", 2)] = &task{cancel: func() { cancelled = true }}
	a := Assignment{Type: "build.cancel", Version: 1, JobID: "job", Attempt: 1}
	b, _ := json.Marshal(a)
	e.Handle(context.Background(), b)
	if cancelled {
		t.Fatal("cancelled newer attempt")
	}
	a.Attempt = 2
	b, _ = json.Marshal(a)
	e.Handle(context.Background(), b)
	if !cancelled {
		t.Fatal("did not cancel")
	}
}
