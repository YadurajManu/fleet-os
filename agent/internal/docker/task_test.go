package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTaskIsolationExitCodeAndCleanup(t *testing.T) {
	deleted := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/json"):
			_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": map[string]string{taskLabel: "true", LabelNode: "node"}}})
		case strings.HasSuffix(r.URL.Path, "/networks/create"):
			_, _ = w.Write([]byte(`{"Id":"network"}`))
		case strings.HasSuffix(r.URL.Path, "/images/create"):
		case strings.HasSuffix(r.URL.Path, "/containers/create"):
			var body struct {
				Cmd, Entrypoint, Env []string
				Labels               map[string]string
				HostConfig           hostConfig
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if !reflect.DeepEqual(body.Cmd, []string{"pnpm", "db:migrate"}) || len(body.Entrypoint) != 0 {
				t.Errorf("command lost: %+v", body)
			}
			if body.Labels[LabelManaged] != "" || body.Labels[taskLabel] != "true" || body.HostConfig.NetworkMode != NetworkName || len(body.HostConfig.Mounts) != 0 || body.HostConfig.RestartPolicy.Name != "" {
				t.Errorf("task could disturb the service: %+v", body)
			}
			if !reflect.DeepEqual(body.Env, []string{"DATABASE_URL=private"}) || body.HostConfig.Memory != 128<<20 || body.HostConfig.NanoCPUs != 1000000000 {
				t.Errorf("environment/resource limit lost: %+v", body)
			}
			_, _ = w.Write([]byte(`{"Id":"task"}`))
		case strings.HasSuffix(r.URL.Path, "/start"):
		case strings.HasSuffix(r.URL.Path, "/wait"):
			_, _ = w.Write([]byte(`{"StatusCode":7}`))
		case strings.HasSuffix(r.URL.Path, "/logs"):
			_, _ = w.Write(append([]byte{1, 0, 0, 0, 0, 0, 0, 4}, []byte("done")...))
		case r.Method == http.MethodDelete:
			deleted = strings.Contains(r.URL.Path, "/fleet-task-") && r.URL.Query().Get("force") == "true" && r.URL.Query().Get("v") == "true"
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	result := c.RunTask(t.Context(), TaskSpec{ID: "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa", NodeID: "node", Image: "app:1", Command: []string{"pnpm", "db:migrate"}, Env: map[string]string{"DATABASE_URL": "private"}, MemoryBytes: 128 << 20, TimeoutMs: 1000})
	if result.ExitCode != 7 || result.Output != "done" || result.Error != "" || !deleted {
		t.Fatalf("%+v cleanup=%v", result, deleted)
	}
}

func TestCancelledTaskStillRemovesItsContainer(t *testing.T) {
	waiting := make(chan struct{})
	removed := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/json"):
			_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": map[string]string{taskLabel: "true", LabelNode: "node"}}})
		case strings.HasSuffix(r.URL.Path, "/wait"):
			close(waiting)
			<-r.Context().Done()
		case r.Method == http.MethodDelete:
			removed <- struct{}{}
		default:
			_, _ = w.Write([]byte(`{"Id":"task"}`))
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", networkReady: true, http: &http.Client{Transport: digestTestTransport{target: target}}}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	finished := make(chan TaskResult, 1)
	go func() {
		finished <- c.RunTask(ctx, TaskSpec{ID: "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa", NodeID: "node", Image: "app:1", Command: []string{"sleep", "60"}, MemoryBytes: 128 << 20, TimeoutMs: 60000})
	}()
	select {
	case <-waiting:
	case <-time.After(time.Second):
		t.Fatal("task did not reach wait")
	}
	cancel()
	select {
	case result := <-finished:
		if result.ExitCode != -1 || result.Error == "" {
			t.Fatal(result)
		}
	case <-time.After(time.Second):
		t.Fatal("task did not cancel")
	}
	select {
	case <-removed:
	default:
		t.Fatal("cancelled task was left running")
	}
}

func TestTaskCleanupRefusesForeignContainers(t *testing.T) {
	for _, labels := range []map[string]string{{taskLabel: "true", LabelNode: "other-node"}, {LabelNode: "node"}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodDelete {
				t.Error("attempted to remove a foreign container")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"Config": map[string]any{"Labels": labels}})
		}))
		target, _ := url.Parse(server.URL)
		c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
		if err := c.removeTask(t.Context(), "foreign", "node"); err == nil {
			t.Error("foreign container ownership accepted")
		}
		server.Close()
	}
}
