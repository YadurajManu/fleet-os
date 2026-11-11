package main

import (
	"flag"
	"io"
	"strings"
	"testing"

	"github.com/fleet-os/fleet-os/agent/internal/state"
)

func TestPairingNeverSilentlyIgnoresAnExplicitToken(t *testing.T) {
	for _, tc := range []struct {
		name         string
		args         []string
		saved        bool
		registerOnly bool
		envToken     string
		wantError    bool
	}{
		{"normal restart", nil, true, false, "", false},
		{"persisted environment on restart", nil, true, false, "pair-secret", false},
		{"explicit token", []string{"--token", "pair-secret"}, true, false, "", true},
		{"explicit empty token", []string{"--token="}, true, false, "", true},
		{"register-only environment token", nil, true, true, "pair-secret", true},
		{"register-only check", nil, true, true, "", false},
		{"first registration", []string{"--token=pair-secret"}, false, true, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			flags := flag.NewFlagSet("agent", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			token := flags.String("token", tc.envToken, "")
			if err := flags.Parse(tc.args); err != nil {
				t.Fatal(err)
			}
			var saved *state.State
			if tc.saved {
				saved = &state.State{NodeID: "original", AgentToken: "agent-secret"}
			}
			err := checkPairingState(saved, flags, tc.registerOnly, *token)
			if (err != nil) != tc.wantError {
				t.Fatalf("error = %v", err)
			}
			if err != nil && (strings.Contains(err.Error(), "pair-secret") || strings.Contains(err.Error(), "agent-secret")) {
				t.Fatal("credential leaked")
			}
			if saved != nil && (saved.NodeID != "original" || saved.AgentToken != "agent-secret") {
				t.Fatal("existing identity changed")
			}
		})
	}
}
