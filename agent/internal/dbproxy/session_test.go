//go:build !windows

package dbproxy

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionCancellationEndsTheClient(t *testing.T) {
	if _, err := exec.LookPath("sleep"); err != nil {
		t.Fatal(err)
	}
	id := "aaaaaaaa111144448888aaaaaaaaaaaa"
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Session(ctx, id, []string{"sleep", "60"}, nil, io.Discard, io.Discard) }()
	socket, err := sessionPath(id)
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		if time.Now().After(until) {
			t.Fatal("session socket missing")
		}
		time.Sleep(time.Millisecond)
	}
	if err := CancelSession(ctx, id); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled command succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("client survived cancellation")
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Fatal("session socket was not removed")
	}
	// No secrets or credential-bearing command strings are used in the cancellation protocol.
	if filepath.Base(socket) != id+".sock" {
		t.Fatal("unexpected session path")
	}
}
