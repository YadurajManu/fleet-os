package build

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
)

var digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var safeID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

type task struct {
	a      Assignment
	cancel context.CancelFunc
	result *Event
}
type Executor struct {
	mu     sync.Mutex
	tasks  map[string]*task
	Config capability.BuilderConfig
	Root   string
	Send   func(Event)
}

func New(root string, config capability.BuilderConfig, send func(Event)) *Executor {
	return &Executor{tasks: map[string]*task{}, Config: config, Root: root, Send: send}
}
func key(id string, attempt int) string { return fmt.Sprintf("%s:%d", id, attempt) }
func (e *Executor) emit(a Assignment, kind, status, text string) {
	ev := Event{Type: kind, Version: 1, JobID: a.JobID, Attempt: a.Attempt, Status: status}
	if kind == "build.log" {
		ev.Text = text
	} else {
		ev.Error = text
	}
	e.Send(ev)
}

// Replay reports real running attempts on reconnect and resends unacknowledged results.
func (e *Executor) Replay() {
	e.mu.Lock()
	events := []Event{}
	for _, t := range e.tasks {
		if t.result != nil {
			events = append(events, *t.result)
		} else {
			events = append(events, Event{Type: "build.renew", Version: 1, JobID: t.a.JobID, Attempt: t.a.Attempt, Status: "running"})
		}
	}
	e.mu.Unlock()
	for _, ev := range events {
		e.Send(ev)
	}
}
func (e *Executor) Handle(ctx context.Context, body []byte) {
	var a Assignment
	if json.Unmarshal(body, &a) != nil || a.Version != 1 || !safeID.MatchString(a.JobID) || a.Attempt < 1 || a.Attempt > 3 {
		return
	}
	k := key(a.JobID, a.Attempt)
	e.mu.Lock()
	if a.Type == "build.receipt" {
		if t := e.tasks[k]; t != nil && t.result != nil {
			delete(e.tasks, k)
		}
		e.mu.Unlock()
		return
	}
	if a.Type == "build.cancel" {
		if t := e.tasks[k]; t != nil {
			t.cancel()
		}
		e.mu.Unlock()
		return
	}
	if a.Type != "build.assign" {
		e.mu.Unlock()
		return
	}
	if t := e.tasks[k]; t != nil {
		ev := t.result
		e.mu.Unlock()
		if ev != nil {
			e.Send(*ev)
		} else {
			e.emit(a, "build.ack", "running", "")
		}
		return
	}
	active := 0
	for _, t := range e.tasks {
		if t.result == nil {
			if a.CacheKey != "" && t.a.CacheKey == a.CacheKey {
				e.mu.Unlock()
				e.emit(a, "build.result", "failed", "app platform already building on this agent")
				return
			}
			active++
		}
	}
	if !e.Config.Builder || active >= e.Config.MaxConcurrentBuilds || len(e.tasks) >= 128 {
		e.mu.Unlock()
		e.emit(a, "build.result", "failed", "builder disabled or at capacity")
		return
	}
	if a.TimeoutMs < 1000 || a.TimeoutMs > 3600000 {
		e.mu.Unlock()
		e.emit(a, "build.result", "failed", "invalid build timeout")
		return
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(a.TimeoutMs)*time.Millisecond)
	t := &task{a: a, cancel: cancel}
	e.tasks[k] = t
	e.mu.Unlock()
	e.emit(a, "build.ack", "running", "")
	go func() {
		defer cancel()
		digest, err := e.execute(runCtx, a)
		ev := Event{Type: "build.result", Version: 1, JobID: a.JobID, Attempt: a.Attempt, Status: "succeeded", Digest: digest}
		if err != nil {
			ev.Status = "failed"
			ev.Error = redact(err.Error(), a)
			ev.Digest = ""
		}
		if runCtx.Err() == context.Canceled {
			ev.Status = "cancelled"
			ev.Error = "build cancelled"
		}
		if runCtx.Err() == context.DeadlineExceeded {
			ev.Status = "failed"
			ev.Error = "build timeout exceeded"
		}
		e.mu.Lock()
		t.result = &ev
		e.mu.Unlock()
		e.Send(ev)
	}()
}

func redact(s string, a Assignment) string {
	values := []string{a.RegistryPassword, a.Source.URL, a.Source.Token}
	for _, v := range a.Secrets {
		values = append(values, v)
	}
	for _, v := range values {
		if v != "" {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	if len(s) > 4096 {
		s = s[:4096]
	}
	return s
}

func (e *Executor) execute(ctx context.Context, a Assignment) (string, error) {
	if a.CPU < 1 || a.CPU > e.Config.CPU || a.MemoryBytes < 256<<20 || a.MemoryBytes > e.Config.MemoryBytes || a.DiskBytes < 1<<30 || a.DiskBytes > e.Config.DiskBytes {
		return "", fmt.Errorf("requested build limits exceed agent limits")
	}
	if _, _, _, err := capability.NormalizePlatform("linux", strings.TrimPrefix(a.Platform, "linux/")); err != nil {
		return "", err
	}
	report, err := capability.DetectEngine(ctx, "")
	if err != nil {
		return "", err
	}
	if report.Platform != a.Platform && !(a.Emulated && report.Platform == "linux/amd64") {
		return "", fmt.Errorf("no native builder for %s", a.Platform)
	}
	if a.RegistryTarget == "" || strings.ContainsAny(a.RegistryTarget, " \n\r") {
		return "", fmt.Errorf("invalid registry target")
	}
	if err = os.MkdirAll(e.Root, 0700); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(e.Root, "job-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	source := filepath.Join(dir, "source")
	if err = os.Mkdir(source, 0700); err != nil {
		return "", err
	}
	if err = fetchSource(ctx, a.Source, source); err != nil {
		return "", err
	}
	if a.Source.Context != "" {
		contextPath, pathErr := safePath(source, a.Source.Context)
		if pathErr != nil {
			return "", pathErr
		}
		resolved, pathErr := filepath.EvalSymlinks(contextPath)
		if pathErr != nil {
			return "", pathErr
		}
		rel, pathErr := filepath.Rel(source, resolved)
		if pathErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("build context escapes checkout")
		}
		source = resolved
	}
	dockerfile, err := safePath(source, a.Dockerfile)
	if err != nil {
		return "", err
	}
	dockerfile, err = filepath.EvalSymlinks(dockerfile)
	if err != nil {
		return "", err
	}
	dockerfileRel, err := filepath.Rel(source, dockerfile)
	if err != nil || dockerfileRel == ".." || strings.HasPrefix(dockerfileRel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("Dockerfile escapes build context")
	}
	configDir := filepath.Join(dir, "docker")
	if err = os.Mkdir(configDir, 0700); err != nil {
		return "", err
	}
	// Per-job credentials are isolated from the operator's Docker login/config.
	host := strings.Split(a.RegistryTarget, "/")[0]
	auth, _ := json.Marshal(map[string]any{"auths": map[string]any{host: map[string]string{"username": a.RegistryUsername, "password": a.RegistryPassword}}})
	if err = os.WriteFile(filepath.Join(configDir, "config.json"), auth, 0600); err != nil {
		return "", err
	}
	cacheID := sha256.Sum256([]byte(a.CacheKey))
	builder := "fleet-" + hex.EncodeToString(cacheID[:12])
	if a.CacheKey == "" {
		builder = "fleet-" + a.JobID + "-" + strconv.Itoa(a.Attempt)
	}
	run := func(args ...string) error {
		cmd := capability.DockerCommand(ctx, args...)
		cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+configDir)
		pipe, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		cmd.Stderr = cmd.Stdout
		if err = cmd.Start(); err != nil {
			return err
		}
		scanner := bufio.NewScanner(pipe)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			e.emit(a, "build.log", "", redact(scanner.Text(), a))
		}
		if err = scanner.Err(); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			return err
		}
		return cmd.Wait()
	}
	// BuildKit gets its own cgroup; Dockerfile RUN steps inherit its limits.
	if err = run("buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", fmt.Sprintf("memory=%d,cpu-period=100000,cpu-quota=%d", a.MemoryBytes, a.CPU*100000), "--buildkitd-flags", fmt.Sprintf("--oci-worker-gc-keepstorage %d", a.DiskBytes/(1<<20)), "--bootstrap"); err != nil {
		return "", fmt.Errorf("create isolated BuildKit: %w", err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := capability.DockerCommand(cleanup, "buildx", "rm", "--force", "--keep-state", builder)
		cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+configDir)
		_ = cmd.Run()
	}()
	buildCtx, stop := context.WithCancel(ctx)
	defer stop()
	// Enforce a measured disk budget, including layers produced by RUN. Docker
	// Desktop cannot supply host filesystem project quotas; sampling may overshoot
	// between checks. Never call this a filesystem hard quota.
	diskExceeded := make(chan struct{}, 1)
	go func() {
		tick := time.NewTicker(5 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-buildCtx.Done():
				return
			case <-tick.C:
				check, cancel := context.WithTimeout(buildCtx, 4*time.Second)
				out, err := capability.DockerCommand(check, "exec", "buildx_buildkit_"+builder+"0", "du", "-sk", "/var/lib/buildkit").Output()
				cancel()
				if err == nil {
					fields := strings.Fields(string(out))
					if len(fields) > 0 {
						kb, _ := strconv.ParseInt(fields[0], 10, 64)
						if kb*1024 > a.DiskBytes {
							diskExceeded <- struct{}{}
							stop()
							return
						}
					}
				}
			}
		}
	}()
	metadata := filepath.Join(dir, "metadata.json")
	args := []string{"buildx", "build", "--builder", builder, "--platform", a.Platform, "--push", "--provenance=false", "--progress=plain", "--network=default", "--tag", a.RegistryTarget, "--file", dockerfile, "--metadata-file", metadata}
	for k, v := range a.BuildArgs {
		if !safeID.MatchString(k) {
			return "", fmt.Errorf("invalid build arg name")
		}
		args = append(args, "--build-arg", k+"="+v)
	}
	for k, v := range a.Secrets {
		if !safeID.MatchString(k) {
			return "", fmt.Errorf("invalid build secret name")
		}
		p := filepath.Join(dir, "secret-"+k)
		if err = os.WriteFile(p, []byte(v), 0600); err != nil {
			return "", err
		}
		args = append(args, "--secret", "id="+k+",src="+p)
	}
	args = append(args, source)
	cmd := capability.DockerCommand(buildCtx, args...)
	cmd.Env = append(os.Environ(), "DOCKER_CONFIG="+configDir)
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	cmd.Stderr = cmd.Stdout
	if err = cmd.Start(); err != nil {
		return "", err
	}
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		e.emit(a, "build.log", "", redact(scanner.Text(), a))
	}
	if scanErr := scanner.Err(); scanErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return "", scanErr
	}
	err = cmd.Wait()
	select {
	case <-diskExceeded:
		return "", fmt.Errorf("build exceeded disk budget")
	default:
	}
	if err != nil {
		return "", fmt.Errorf("build failed: %w", err)
	}
	body, err := os.ReadFile(metadata)
	if err != nil {
		return "", err
	}
	var result map[string]json.RawMessage
	if err = json.Unmarshal(body, &result); err != nil {
		return "", err
	}
	var digest string
	_ = json.Unmarshal(result["containerimage.digest"], &digest)
	if !digestPattern.MatchString(digest) {
		return "", fmt.Errorf("BuildKit did not return a valid image digest")
	}
	return digest, nil
}

func safePath(root, name string) (string, error) {
	cleaned := filepath.Clean(filepath.FromSlash(name))
	if name == "" || filepath.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) || strings.Contains(name, "\\") || strings.Contains(name, ":") {
		return "", fmt.Errorf("unsafe source path")
	}
	return filepath.Join(root, cleaned), nil
}
func fetchSource(ctx context.Context, s Source, dest string) error {
	if s.Repository != "" {
		return fetchGit(ctx, s, dest)
	}
	u, err := url.Parse(s.URL)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return fmt.Errorf("source requires HTTPS")
	}
	client := http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("source redirects are not allowed") }}
	req, err := http.NewRequestWithContext(ctx, "GET", s.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("source download failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("source download returned %d", res.StatusCode)
	}
	file, err := os.CreateTemp(filepath.Dir(dest), "source-*.tgz")
	if err != nil {
		return err
	}
	defer file.Close()
	defer os.Remove(file.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, h), io.LimitReader(res.Body, (256<<20)+1))
	if err != nil {
		return err
	}
	if n > 256<<20 {
		return fmt.Errorf("source archive exceeds 256MiB")
	}
	if hex.EncodeToString(h.Sum(nil)) != s.SHA256 {
		return fmt.Errorf("source checksum mismatch")
	}
	if _, err = file.Seek(0, 0); err != nil {
		return err
	}
	return extract(file, dest)
}
func extract(r io.Reader, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var total int64
	for count := 0; ; count++ {
		head, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if count > 100000 {
			return fmt.Errorf("too many source entries")
		}
		path, err := safePath(dest, head.Name)
		if err != nil {
			return err
		}
		switch head.Typeflag {
		case tar.TypeDir:
			if err = os.MkdirAll(path, 0700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			total += head.Size
			if head.Size < 0 || total > 1<<30 {
				return fmt.Errorf("expanded source exceeds 1GiB")
			}
			if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				return err
			}
			f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(head.Mode)&0777)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			closeErr := f.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return fmt.Errorf("source links and special files are not allowed")
		}
	}
}

func fetchGit(ctx context.Context, s Source, dest string) error {
	u, err := url.Parse(s.Repository)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || !regexp.MustCompile(`^[a-fA-F0-9]{40}$`).MatchString(s.Commit) {
		return fmt.Errorf("Git source requires a GitHub HTTPS repository and exact commit SHA")
	}
	for _, args := range [][]string{{"init", dest}, {"-C", dest, "fetch", "--depth=1", "--no-tags", s.Repository, s.Commit}, {"-C", dest, "checkout", "--detach", "FETCH_HEAD"}} {
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http.https://github.com/.extraheader", "GIT_CONFIG_VALUE_0=Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+s.Token)))
		if err = cmd.Run(); err != nil {
			return fmt.Errorf("could not fetch the exact GitHub commit")
		}
	}
	return nil
}
