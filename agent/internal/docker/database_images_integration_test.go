package docker

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
)

func TestDatabaseImagePrepullRealRegistry(t *testing.T) {
	input := os.Getenv("FLEET_DB_PREPULL_TEST")
	if input == "" {
		t.Skip("run control-plane/tests/database-registry.docker.ts for the isolated authenticated registry fixture")
	}
	var spec struct {
		Reference string `json:"reference"`
		Platform  string `json:"platform"`
		Auth      string `json:"auth"`
	}
	if json.Unmarshal([]byte(input), &spec) != nil || spec.Reference == "" || spec.Auth == "" {
		t.Fatal("invalid registry test setup")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	budget, err := capability.ProbeDisk(ctx, t.TempDir(), 1<<30, "")
	if err != nil {
		t.Fatal("cannot measure real Docker disk headroom")
	}
	c := New("")
	image := DatabaseImage{Reference: spec.Reference, Platform: spec.Platform, RequiredBytes: 1 << 30}
	if err := c.PrepullDatabaseImages(ctx, []DatabaseImage{image}, spec.Auth, budget, nil); err != nil {
		t.Fatal(err)
	}
	// The second invocation must use the installed content without needing credentials.
	if err := c.PrepullDatabaseImages(ctx, []DatabaseImage{image}, "", capability.DiskBudget{Free: 1 << 30, Reserve: 1 << 30}, nil); err != nil {
		t.Fatal(err)
	}
}
