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
func TestCacheCapAppliedAfterEveryBuild(t *testing.T) {
	for i := 0; i < 3; i++ {
		calls := 0
		err := pruneCache(func(args ...string) ([]byte, error) {
			if args[len(args)-1] == "--help" {
				return []byte("--keep-storage"), nil
			}
			calls++
			if args[len(args)-2] != "--keep-storage" || args[len(args)-1] != "10737418240B" {
				t.Fatal(args)
			}
			return nil, nil
		}, "fleet-test", 10<<30)
		if err != nil || calls != 1 {
			t.Fatal("missing post-build cap", i, err)
		}
	}
}
