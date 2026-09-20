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
