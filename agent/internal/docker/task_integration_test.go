package docker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestTaskOnRealDocker(t *testing.T) {
	if os.Getenv("FLEET_DOCKER_INTEGRATION") != "1" {
		t.Skip("set FLEET_DOCKER_INTEGRATION=1 to exercise a temporary Docker network service")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	c := New("")
	if err := c.EnsureNetwork(ctx); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("fleet-task-check-%d", time.Now().UnixNano())
	cmd := exec.CommandContext(ctx, "docker", "run", "-d", "--rm", "--name", name, "--network", NetworkName, "--network-alias", name, "busybox:1.37", "sh", "-c", "mkdir -p /www; echo private-network-ok > /www/index.html; exec httpd -f -p 8080 -h /www")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("test service: %v %s", err, output)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_ = exec.CommandContext(cleanup, "docker", "rm", "-f", name).Run()
	}()
	spec := TaskSpec{ID: "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa", NodeID: name, Image: "busybox:1.37", Command: []string{"sh", "-c", "printf '%s\\n' \"$TASK_ENV\"; wget -qO- http://" + name + ":8080; exit 7"}, Env: map[string]string{"TASK_ENV": "injected-env-ok"}, MemoryBytes: 64 << 20, TimeoutMs: 15000}
	result := c.RunTask(ctx, spec)
	if result.ExitCode != 7 || result.Error != "" || !strings.Contains(result.Output, "private-network-ok") || !strings.Contains(result.Output, "injected-env-ok") {
		t.Fatalf("task result: %+v", result)
	}
	output, err := exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", "name=^/fleet-task-"+spec.ID+"$").Output()
	if err != nil || strings.TrimSpace(string(output)) != "" {
		t.Fatal("temporary task was not removed", err, string(output))
	}
	// Cancel an actually running process, rather than only a pending request.
	spec.ID = "bbbbbbbb-1111-4444-8888-bbbbbbbbbbbb"
	spec.Command = []string{"sleep", "30"}
	taskCtx, stopTask := context.WithCancel(ctx)
	defer stopTask()
	resultCh := make(chan TaskResult, 1)
	go func() { resultCh <- c.RunTask(taskCtx, spec) }()
	running := false
	for i := 0; i < 50; i++ {
		state, _ := exec.CommandContext(ctx, "docker", "inspect", "fleet-task-"+spec.ID, "--format", "{{.State.Running}}").Output()
		if strings.TrimSpace(string(state)) == "true" {
			running = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !running {
		t.Fatal("temporary task did not start")
	}
	stopTask()
	select {
	case cancelled := <-resultCh:
		if cancelled.ExitCode != -1 || cancelled.Error == "" {
			t.Fatal(cancelled)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("running task did not cancel and clean up")
	}
	output, err = exec.CommandContext(ctx, "docker", "ps", "-aq", "--filter", "name=^/fleet-task-"+spec.ID+"$").Output()
	if err != nil || strings.TrimSpace(string(output)) != "" {
		t.Fatal("cancelled process was left running", err, string(output))
	}
}
