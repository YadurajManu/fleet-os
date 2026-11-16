package docker

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
)

func TestDatabaseImagePrepullChecksPinPlatformCacheAndDisk(t *testing.T) {
	pulls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			if strings.Contains(r.URL.Path, "cached") {
				_, _ = w.Write([]byte(`{"Os":"linux","Architecture":"arm64"}`))
				return
			}
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/images/create") {
			pulls++
			if r.URL.Query().Get("platform") != "linux/arm64" {
				t.Error("lost execution platform")
			}
			_, _ = w.Write([]byte(`{"status":"Downloaded"}`))
			return
		}
		t.Errorf("unexpected Docker request %s", r.URL.Path)
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: digestTestTransport{target: target}}}
	ref := "registry.test/primary@sha256:" + strings.Repeat("a", 64)
	image := DatabaseImage{Reference: ref, Platform: "linux/arm64", RequiredBytes: 1 << 30}
	budget := capability.DiskBudget{Free: 3 << 30, Reserve: 1 << 30}
	if err := c.PrepullDatabaseImages(context.Background(), []DatabaseImage{image}, "", budget, nil); err != nil {
		t.Fatal(err)
	}
	if pulls != 1 {
		t.Fatal("image was not pulled")
	}
	image.Reference = "registry.test/cached@sha256:" + strings.Repeat("a", 64)
	if err := c.PrepullDatabaseImages(context.Background(), []DatabaseImage{image}, "", capability.DiskBudget{Free: 1 << 30, Reserve: 1 << 30}, nil); err != nil {
		t.Fatal(err)
	}
	if pulls != 1 {
		t.Fatal("cached image was downloaded again")
	}
	image.Reference = ref
	if err := c.PrepullDatabaseImages(context.Background(), []DatabaseImage{image}, "", capability.DiskBudget{Free: 1 << 30, Reserve: 1 << 30}, nil); err == nil {
		t.Fatal("disk reserve was ignored")
	}
	image.Reference = "registry.test/primary:latest"
	if err := c.PrepullDatabaseImages(context.Background(), []DatabaseImage{image}, "", budget, nil); err == nil {
		t.Fatal("mutable database image accepted")
	}
}
