package capability

import (
	"strings"
	"testing"
)

func TestEnginePlatformNormalization(t *testing.T) {
	for input, want := range map[string]string{"x86_64": "linux/amd64", "amd64": "linux/amd64", "aarch64": "linux/arm64", "arm64": "linux/arm64", "armv7l": "linux/arm/v7"} {
		got, _, _, err := NormalizePlatform("linux", input)
		if err != nil || got != want {
			t.Fatalf("%s: %s %v", input, got, err)
		}
	}
	if _, _, _, err := NormalizePlatform("linux", "arm"); err == nil {
		t.Fatal("ambiguous ARM variant accepted")
	}
}
func TestRefusesWindowsContainers(t *testing.T) {
	_, _, err := FromDockerInfo([]byte(`{"OSType":"windows","Architecture":"x86_64","NCPU":8,"MemTotal":8589934592}`))
	if err == nil || !strings.Contains(err.Error(), "Switch Docker Desktop to Linux containers") {
		t.Fatalf("wrong refusal: %v", err)
	}
}
func TestDockerDesktopUsesEngineCapacity(t *testing.T) {
	r, arch, err := FromDockerInfo([]byte(`{"OSType":"linux","Architecture":"aarch64","OperatingSystem":"Docker Desktop","NCPU":4,"MemTotal":4294967296}`))
	if err != nil || r.Platform != "linux/arm64" || arch != "arm64" || r.EngineKind != "docker-desktop" || r.EffectiveCPU != 4 || r.EffectiveMemBytes != 4294967296 || r.CanBuild {
		t.Fatalf("bad report: %+v %v", r, err)
	}
}
