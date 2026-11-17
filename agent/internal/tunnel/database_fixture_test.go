package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
	"github.com/fleet-os/fleet-os/agent/internal/database"
	"github.com/fleet-os/fleet-os/agent/internal/docker"
)

// Run by the Docker tunnel test; fixture credentials only enter the child environment.
func TestDatabaseTunnelPeer(t *testing.T) {
	input := os.Getenv("FLEET_DB_TUNNEL_FIXTURE")
	if input == "" {
		t.Skip("run database-tunnel.docker.ts")
	}
	var config struct{ URL, Token, NodeID, FleetID string }
	if json.Unmarshal([]byte(input), &config) != nil {
		t.Fatal("invalid tunnel fixture")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 12*time.Minute)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	root := t.TempDir()
	report, err := capability.DetectEngine(ctx, "database-fixture")
	if err != nil {
		t.Fatal("cannot detect fixture engine")
	}
	builderConfig, err := capability.LoadBuilderConfig(root)
	if err != nil {
		t.Fatal("cannot load fixture builder settings")
	}
	if err := capability.ApplyBuilder(ctx, &report, root, builderConfig); err != nil {
		t.Fatal("database disk probe failed")
	}
	if report.CanBuild || report.BuildCacheFreeBytes <= 0 || report.BuildDiskReserveBytes <= 0 {
		t.Fatal("non-builder did not report safe database disk headroom")
	}
	client := New(config.URL, config.Token, slog.New(slog.NewTextHandler(io.Discard, nil)))
	client.NodeID = config.NodeID
	client.Databases = &database.Handler{Runtime: &docker.DatabaseRuntime{Docker: docker.New(""), NodeID: config.NodeID, FleetID: config.FleetID, Dir: t.TempDir()}, Send: client.SendDatabase}
	client.Run(ctx)
}
