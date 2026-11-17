package database

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/docker"
)

func TestWindowBoundsOutputAndReleasesCredit(t *testing.T) {
	for _, window := range []int{1, 16} {
		t.Run(strconv.Itoa(window), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			s := &stream{ctx: ctx, cancel: cancel, window: window, ack: make(chan int, window)}
			sent := make(chan Event, 32)
			h := &Handler{Send: func(_ context.Context, event Event) { sent <- event }}
			writer := &streamWriter{handler: h, stream: s, channel: "stdout"}
			done := make(chan error, 1)
			go func() { _, err := writer.Write(make([]byte, (window+1)*frameSize)); done <- err }()
			for i := 1; i <= window; i++ {
				select {
				case e := <-sent:
					if e.Seq != i {
						t.Fatal("sequence changed")
					}
				case <-time.After(time.Second):
					t.Fatal("window did not fill")
				}
			}
			select {
			case <-sent:
				t.Fatal("sender exceeded credit")
			case <-time.After(20 * time.Millisecond):
			}
			s.ack <- 1
			select {
			case e := <-sent:
				if e.Seq != window+1 {
					t.Fatal("credit not released")
				}
			case <-time.After(time.Second):
				t.Fatal("sender did not resume")
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			cancel()
		})
	}
}

func TestInvalidFramesCancelSession(t *testing.T) {
	for _, mode := range []string{"order", "size", "credit"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			id := "aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa"
			s := &stream{ctx: ctx, cancel: cancel, window: 16, input: make(chan packet, 17)}
			h := &Handler{Runtime: &docker.DatabaseRuntime{}, Send: func(context.Context, Event) {}, streams: map[string]*stream{id: s}}
			send := func(seq, size int) {
				body, _ := json.Marshal(Message{Type: "db.data", Version: 1, ID: id, Seq: seq, Data: base64.StdEncoding.EncodeToString(make([]byte, size))})
				h.Handle(ctx, body)
			}
			switch mode {
			case "order":
				send(2, 1)
			case "size":
				send(1, frameSize+1)
			case "credit":
				for seq := 1; seq <= 17; seq++ {
					send(seq, frameSize)
				}
			}
			if ctx.Err() == nil {
				t.Fatal("invalid frame accepted")
			}
		})
	}
}

func TestDropUnblocksWindowWait(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	s := &stream{ctx: ctx, cancel: cancel, window: 1, ack: make(chan int, 1)}
	h := &Handler{Send: func(context.Context, Event) {}}
	done := make(chan error, 1)
	go func() { _, err := (&streamWriter{handler: h, stream: s}).Write(make([]byte, frameSize*2)); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("dropped stream succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("drop stranded writer")
	}
}
