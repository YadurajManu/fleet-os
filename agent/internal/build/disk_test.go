package build

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestBudgetViolationCancelsSolveAndPrunes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := watchDisk(ctx, cancel, time.Millisecond, func(context.Context) error { return errors.New("disk budget exceeded") })
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("solve not cancelled")
	}
	if err := <-result; err.Error() != "disk budget exceeded" {
		t.Fatal(err)
	}
	pruned := false
	err := pruneCache(func(args ...string) ([]byte, error) {
		if args[len(args)-1] == "--help" {
			return []byte("--max-used-space"), nil
		}
		pruned = strings.Join(args, " ") == "buildx prune --builder fleet-test --all --force --max-used-space 10737418240B"
		return nil, nil
	}, "fleet-test", 10<<30)
	if err != nil || !pruned {
		t.Fatal("cache was not pruned", err)
	}
}
func TestPruningPreservesUnrelatedAndCurrentVolumes(t *testing.T) {
	retained := "fleet-aaaaaaaaaaaaaaaaaaaaaaaa"
	removed := []string{}
	err := pruneDangling(func(args ...string) ([]byte, error) {
		if args[0] == "volume" && args[1] == "ls" {
			return []byte("postgres-data\nbuildx_buildkit_fleet-aaaaaaaaaaaaaaaaaaaaaaaa0_state\nbuildx_buildkit_fleet-bbbbbbbbbbbbbbbbbbbbbbbb0_state\nbuildx_buildkit_user0_state\n"), nil
		}
		if args[0] == "volume" && args[1] == "rm" {
			removed = append(removed, args[2])
		}
		if args[0] == "image" && args[len(args)-1] != "label=io.fleet.builder=true" {
			t.Fatal("unscoped image prune")
		}
		return nil, nil
	}, retained)
	if err != nil || len(removed) != 1 || removed[0] != "buildx_buildkit_fleet-bbbbbbbbbbbbbbbbbbbbbbbb0_state" {
		t.Fatal(removed, err)
	}
}
