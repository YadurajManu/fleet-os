package docker

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"testing"
	"time"
)

func TestDatabaseRuntimeRealDocker(t *testing.T) {
	input := os.Getenv("FLEET_DB_RUNTIME_TEST")
	if input == "" {
		t.Skip("run database-runtime.docker.ts with disposable maintained images")
	}
	var operation DatabaseOperation
	if json.Unmarshal([]byte(input), &operation) != nil {
		t.Fatal("invalid runtime fixture")
	}
	root := t.TempDir()
	runtime := &DatabaseRuntime{Docker: New(""), NodeID: operation.Identity.NodeID, FleetID: operation.Identity.FleetID, Dir: root}
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	receipt, err := runtime.Apply(ctx, operation)
	if err != nil || !receipt.Complete || !receipt.Bootstrapped {
		t.Fatal("provision failed", err)
	}
	// Simulate process replacement: no plan is retained by the runtime object.
	runtime = &DatabaseRuntime{Docker: New(""), NodeID: operation.Identity.NodeID, FleetID: operation.Identity.FleetID, Dir: root}
	if _, err := runtime.Apply(ctx, operation); err != nil {
		t.Fatal("receipt replay failed", err)
	}
	for i, action := range []string{"stop", "start", "restart"} {
		next := operation
		next.ID = []string{"11111111-1111-4444-8888-111111111111", "22222222-1111-4444-8888-222222222222", "33333333-1111-4444-8888-333333333333"}[i]
		next.Action = action
		next.Containers = nil
		next.Bootstrap = nil
		if _, err := runtime.Apply(ctx, next); err != nil {
			t.Fatal("lifecycle failed", action, err)
		}
		state, err := runtime.Docker.Inspect(ctx, DatabaseContainerName(operation.Identity.ID, "database"))
		if err != nil || state.Running != (action != "stop") {
			t.Fatal("incorrect lifecycle state", action)
		}
		if _, err := runtime.Apply(ctx, next); err != nil {
			t.Fatal("lifecycle retry failed", action, err)
		}
	}
	// The proxy must reach the private engine without publishing a host port. Send a Redis or PostgreSQL startup probe.
	var command DatabaseCommand
	if operation.Containers[0].DataPath == "/data" {
		command = DatabaseCommand{Command: []string{"fleet-db-proxy", "6379"}, Stdin: "*1\r\n$4\r\nPING\r\n"}
	} else {
		command = DatabaseCommand{Command: []string{"fleet-db-proxy", "5432"}, Stdin: string([]byte{0, 0, 0, 8, 4, 210, 22, 47})}
	}
	// These probes are intentionally unauthenticated: Redis returns NOAUTH and PostgreSQL answers its SSL negotiation byte.
	var output boundedProbe
	code, err := runtime.Docker.ExecDatabase(ctx, operation.Identity, "database", command, nil, &output, io.Discard, false, 2*time.Second, nil)
	if err != nil && ctx.Err() != nil {
		t.Fatal("proxy deadline failed")
	}
	if len(output.data) == 0 {
		t.Fatal("private TCP proxy produced no engine response", code)
	}
}

type boundedProbe struct{ data []byte }

func (p *boundedProbe) Write(data []byte) (int, error) {
	n := len(data)
	if len(p.data) < 4096 {
		remaining := 4096 - len(p.data)
		if len(data) > remaining {
			data = data[:remaining]
		}
		p.data = append(p.data, data...)
	}
	return n, nil
}
