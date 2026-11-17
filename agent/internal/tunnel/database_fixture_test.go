package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

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
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	client := New(config.URL, config.Token, slog.New(slog.NewTextHandler(io.Discard, nil)))
	client.NodeID = config.NodeID
	client.Databases = &database.Handler{Runtime: &docker.DatabaseRuntime{Docker: docker.New(""), NodeID: config.NodeID, FleetID: config.FleetID, Dir: t.TempDir()}, Send: client.SendDatabase}
	client.Run(ctx)
}
