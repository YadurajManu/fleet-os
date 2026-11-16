package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Invoked by the TS engine-plan test with credentials in the child environment, never argv.
func TestDatabaseResourceRealDocker(t *testing.T) {
	input := os.Getenv("FLEET_DB_RESOURCE_TEST")
	if input == "" {
		t.Skip("run control-plane/tests/database-plugins.docker.ts for the maintained-image fixture")
	}
	var setup struct {
		DatabaseContainerSpec
		Readiness DatabaseCommand `json:"readiness"`
		Command   DatabaseCommand `json:"command"`
		Expected  string          `json:"expected"`
	}
	if json.Unmarshal([]byte(input), &setup) != nil {
		t.Fatal("invalid database fixture input")
	}
	spec := setup.DatabaseContainerSpec
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	c := New("")
	if os.Getenv("FLEET_DB_RESOURCE_ACTION") == "exec" {
		var output, errors bytes.Buffer
		code, err := c.ExecDatabase(ctx, spec.Identity, spec.Container.Role, setup.Command, nil, &output, &errors, false, 10*time.Second, nil)
		if err != nil || code != 0 || strings.TrimSpace(output.String()) != setup.Expected {
			t.Fatal("real database exec did not preserve the expected role isolation; raw output withheld")
		}
		return
	}
	if os.Getenv("FLEET_DB_RESOURCE_ACTION") == "stop" {
		if err := c.StopDatabaseContainer(ctx, spec.Identity, spec.Container.Role); err != nil {
			t.Fatal(err)
		}
		state, err := c.Inspect(ctx, DatabaseContainerName(spec.Identity.ID, spec.Container.Role))
		if err != nil || state.Running {
			t.Fatal("database did not stop cleanly")
		}
		return
	}
	id, err := c.EnsureDatabaseContainer(ctx, spec)
	if err != nil || id == "" {
		t.Fatal("database resource creation failed", err)
	}
	spec.Initialize = false
	retried, err := c.EnsureDatabaseContainer(ctx, spec)
	if err != nil || retried != id {
		t.Fatal("database resource retry was not idempotent")
	}
	state, err := c.Inspect(ctx, id)
	if err != nil {
		t.Fatal("cannot inspect created database")
	}
	if !state.Running {
		if err := c.Start(ctx, id); err != nil {
			t.Fatal("cannot start created database")
		}
	}
	if len(setup.Readiness.Command) > 0 {
		until := time.Now().Add(45 * time.Second)
		for {
			var output, errors bytes.Buffer
			code, err := c.ExecDatabase(ctx, spec.Identity, spec.Container.Role, setup.Readiness, nil, &output, &errors, false, 10*time.Second, nil)
			value := strings.TrimSpace(output.String())
			if err == nil && code == 0 && (value == "1" || value == "PONG") {
				break
			}
			if time.Now().After(until) {
				t.Fatal("real Docker database exec/readiness failed; raw output withheld")
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
}
