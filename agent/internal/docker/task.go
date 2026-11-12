package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const taskLabel = "io.fleet.task"

type TaskSpec struct {
	ID           string            `json:"id"`
	NodeID       string            `json:"node_id"`
	Service      string            `json:"service"`
	Image        string            `json:"image"`
	Platform     string            `json:"platform"`
	Command      []string          `json:"command"`
	Env          map[string]string `json:"env"`
	RegistryAuth string            `json:"registry_auth"`
	MemoryBytes  int64             `json:"memory_bytes"`
	CPUMillis    int64             `json:"cpu_millis"`
	TimeoutMs    int64             `json:"timeout_ms"`
}

type TaskResult struct {
	CleanupComplete bool   `json:"cleanupComplete"`
	ExitCode        int    `json:"exitCode"`
	Output          string `json:"output"`
	Error           string `json:"error,omitempty"`
}

// RunTask uses a separate container: cancellation can stop it without touching
// the serving release, and application data volumes are never mounted.
func (c *Client) RunTask(ctx context.Context, spec TaskSpec) (result TaskResult) {
	result.ExitCode = -1
	result.CleanupComplete = true
	if spec.CPUMillis == 0 {
		spec.CPUMillis = 1000
	}
	if spec.CPUMillis < 10 || spec.CPUMillis > 1024000 {
		result.Error = "invalid task CPU limit"
		return
	}
	if !regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).MatchString(spec.ID) || spec.NodeID == "" || len(spec.Command) == 0 || len(spec.Command) > 128 || spec.Image == "" || spec.MemoryBytes < 6<<20 || spec.TimeoutMs < 1000 || spec.TimeoutMs > 600000 {
		result.Error = "invalid task specification"
		return
	}
	size := 0
	for _, arg := range spec.Command {
		size += len(arg)
		if strings.ContainsRune(arg, 0) || len(arg) > 8192 {
			result.Error = "invalid task argument"
			return
		}
	}
	if spec.Command[0] == "" || size > 32768 {
		result.Error = "invalid task command"
		return
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(spec.TimeoutMs)*time.Millisecond)
	defer cancel()
	if err := c.EnsureNetwork(ctx); err != nil {
		result.Error = "task network: " + err.Error()
		return
	}
	if err := c.PullForPlatform(ctx, spec.Image, spec.RegistryAuth, spec.Platform, nil); err != nil {
		result.Error = "task image: " + err.Error()
		return
	}
	keys := make([]string, 0, len(spec.Env))
	for key := range spec.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, key := range keys {
		env = append(env, key+"="+spec.Env[key])
	}
	name := "fleet-task-" + spec.ID
	// Clean up by deterministic name even if the create response is lost.
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if err := c.removeTask(cleanup, name, spec.NodeID); err != nil {
			result.CleanupComplete = false
			result.Error = "task cleanup failed: " + err.Error()
			result.ExitCode = -1
		}
	}()
	request := struct {
		Image       string
		Cmd         []string
		Entrypoint  []string
		Env         []string
		Labels      map[string]string
		HostConfig  hostConfig
		Healthcheck *healthcheck
	}{spec.Image, spec.Command, []string{}, env, map[string]string{taskLabel: "true", LabelNode: spec.NodeID}, hostConfig{Memory: spec.MemoryBytes, NanoCPUs: spec.CPUMillis * 1000000, NetworkMode: NetworkName}, &healthcheck{Test: []string{"NONE"}}}
	var created createResponse
	path := fmt.Sprintf("/%s/containers/create?name=%s", c.api(ctx), url.QueryEscape(name))
	if spec.Platform != "" {
		path += "&platform=" + url.QueryEscape(spec.Platform)
	}
	if err := c.do(ctx, http.MethodPost, path, request, &created); err != nil {
		result.Error = "create task: " + err.Error()
		return
	}
	if err := c.Start(ctx, name); err != nil {
		result.Error = "start task: " + err.Error()
		return
	}
	var waited struct {
		StatusCode int
		Error      *struct{ Message string }
	}
	err := c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/"+name+"/wait?condition=not-running", nil, &waited)
	if err != nil {
		result.Error = "wait for task: " + err.Error()
		return
	}
	if waited.Error != nil && waited.Error.Message != "" {
		result.Error = waited.Error.Message
		return
	}
	result.ExitCode = waited.StatusCode
	output, err := c.Logs(ctx, name, 200)
	if err != nil {
		result.Error = "read task output: " + err.Error()
		result.ExitCode = -1
		return
	}
	if len(output) > 256<<10 {
		output = "[output truncated]\n" + output[len(output)-(256<<10)+32:]
	}
	result.Output = output
	return
}

func (c *Client) removeTask(ctx context.Context, name, nodeID string) error {
	var inspected struct {
		Config struct{ Labels map[string]string }
	}
	if err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/containers/"+name+"/json", nil, &inspected); err != nil {
		if IsNotFound(err) {
			return nil
		}
		return err
	}
	if inspected.Config.Labels[taskLabel] != "true" || inspected.Config.Labels[LabelNode] != nodeID {
		return fmt.Errorf("refusing to remove a container not owned by this task node")
	}

	err := c.do(ctx, http.MethodDelete, "/"+c.api(ctx)+"/containers/"+name+"?force=true&v=true", nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// Reap only this node's abandoned temporary containers after a reconnect/restart.
func (c *Client) CleanupTasks(ctx context.Context, nodeID string) error {
	if nodeID == "" {
		return nil
	}
	filters, _ := json.Marshal(map[string][]string{"label": {taskLabel + "=true", LabelNode + "=" + nodeID}})
	var containers []ContainerSummary
	if err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/containers/json?all=true&filters="+url.QueryEscape(string(filters)), nil, &containers); err != nil {
		return err
	}
	for _, container := range containers {
		if container.Labels[taskLabel] != "true" || container.Labels[LabelNode] != nodeID {
			continue
		}
		if err := c.removeTask(ctx, container.ID, nodeID); err != nil {
			return err
		}
	}
	return nil
}
