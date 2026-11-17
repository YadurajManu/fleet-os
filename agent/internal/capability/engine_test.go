package capability

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestVerifiedDatabaseCapabilitiesAreAdvertised(t *testing.T) {
	r, _, err := FromDockerInfo([]byte(`{"OSType":"linux","Architecture":"aarch64","NCPU":4,"MemTotal":4294967296}`))
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.DatabaseCapabilities, []string{"database.runtime.v1", "database.tcp.v1", "database.exec.v1"}) || !strings.Contains(string(body), "database_capabilities") {
		t.Fatal("verified runtime/exec/TCP capabilities missing or unimplemented capabilities advertised")
	}
}

func TestBuilderReportsConfiguredMemoryCeiling(t *testing.T) {
	for _, ceiling := range []int64{2 << 30, 8 << 30} {
		report := Report{EngineReport: &EngineReport{}}
		if err := ApplyBuilder(context.Background(), &report, t.TempDir(), BuilderConfig{MemoryBytes: ceiling}); err != nil {
			t.Fatal(err)
		}
		if report.BuildMemoryBytes != ceiling {
			t.Fatalf("reported %d, want configured ceiling %d", report.BuildMemoryBytes, ceiling)
		}
	}
}

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

func TestDatabaseCapabilitiesRequireMaintainedImageArchitecture(t *testing.T) {
	report, _, err := FromDockerInfo([]byte(`{"OSType":"linux","Architecture":"armv7l","NCPU":4,"MemTotal":4294967296}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(report.DatabaseCapabilities) != 0 {
		t.Fatal("advertised database images on unsupported ARMv7")
	}
}
