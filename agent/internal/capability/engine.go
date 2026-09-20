package capability

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// EngineReport describes the Linux container engine, never the agent host.
type EngineReport struct {
	Platform            string   `json:"platform"`
	Variant             string   `json:"variant,omitempty"`
	EngineKind          string   `json:"engine_kind"`
	EffectiveCPU        int      `json:"effective_cpu"`
	EffectiveMemBytes   int64    `json:"effective_mem_bytes"`
	CanBuild            bool     `json:"can_build"`
	Platforms           []string `json:"platforms"`
	MaxConcurrentBuilds int      `json:"max_concurrent_builds"`
	BuildCacheFreeBytes int64    `json:"build_cache_free_bytes"`
}

type BuilderConfig struct {
	Builder             bool  `json:"builder"`
	MaxConcurrentBuilds int   `json:"max_concurrent_builds"`
	CPU                 int   `json:"build_cpu"`
	MemoryBytes         int64 `json:"build_memory_bytes"`
	DiskBytes           int64 `json:"build_disk_bytes"`
}

func LoadBuilderConfig(dir string) (BuilderConfig, error) {
	c := BuilderConfig{MaxConcurrentBuilds: 1, CPU: 2, MemoryBytes: 2 << 30, DiskBytes: 20 << 30}
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("agent config.json: %w", err)
	}
	if c.MaxConcurrentBuilds < 1 || c.MaxConcurrentBuilds > 16 || c.CPU < 1 || c.MemoryBytes < 256<<20 || c.DiskBytes < 1<<30 {
		return c, fmt.Errorf("invalid builder resource limits")
	}
	return c, nil
}

// NormalizePlatform deliberately rejects ambiguous ARM versions and Windows containers.
func NormalizePlatform(osType, arch string) (string, string, string, error) {
	if osType != "linux" {
		return "", "", "", fmt.Errorf("Switch Docker Desktop to Linux containers")
	}
	switch strings.ToLower(arch) {
	case "amd64", "x86_64":
		return "linux/amd64", "amd64", "", nil
	case "arm64", "aarch64", "arm64/v8":
		return "linux/arm64", "arm64", "", nil
	case "armv7", "armv7l", "arm/v7":
		return "linux/arm/v7", "armv7", "v7", nil
	default:
		return "", "", "", fmt.Errorf("unsupported Docker engine architecture %q", arch)
	}
}

func FromDockerInfo(body []byte) (EngineReport, string, error) {
	var info struct {
		OSType, Architecture, OperatingSystem string
		NCPU                                  int
		MemTotal                              int64
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return EngineReport{}, "", err
	}
	p, arch, variant, err := NormalizePlatform(info.OSType, info.Architecture)
	if err != nil {
		return EngineReport{}, "", err
	}
	if info.NCPU < 1 || info.MemTotal < 64<<20 {
		return EngineReport{}, "", fmt.Errorf("Docker engine did not report usable NCPU/MemTotal")
	}
	kind := "native"
	if strings.Contains(strings.ToLower(info.OperatingSystem), "docker desktop") {
		kind = "docker-desktop"
	}
	return EngineReport{Platform: p, Variant: variant, EngineKind: kind, EffectiveCPU: info.NCPU, EffectiveMemBytes: info.MemTotal, Platforms: []string{p}, MaxConcurrentBuilds: 1}, arch, nil
}

func DockerCommand(ctx context.Context, args ...string) *exec.Cmd {
	path := "docker"
	if _, err := exec.LookPath(path); err != nil {
		for _, candidate := range []string{"/usr/local/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"} {
			if _, err := os.Stat(candidate); err == nil {
				path = candidate
				break
			}
		}
	}
	return exec.CommandContext(ctx, path, args...)
}

func DetectEngine(ctx context.Context, version string) (Report, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	body, err := DockerCommand(ctx, "info", "--format", "{{json .}}").Output()
	if err != nil {
		return Report{}, fmt.Errorf("cannot detect Docker engine platform: %w", err)
	}
	engine, arch, err := FromDockerInfo(body)
	if err != nil {
		return Report{}, err
	}
	report := Detect(version)
	report.EngineReport = &engine
	report.OS = "linux"
	report.Arch = arch
	report.CPUCores = engine.EffectiveCPU
	report.RAMMb = int(engine.EffectiveMemBytes / (1 << 20))
	return report, nil
}
