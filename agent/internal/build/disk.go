package build

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// watchDisk cancels only the Docker solve context. The assignment remains alive
// so the final result is failed with the disk error, rather than timed_out.
func watchDisk(ctx context.Context, stop context.CancelFunc, interval time.Duration, sample func(context.Context) error) <-chan error {
	result := make(chan error, 1)
	go func() {
		tick := time.NewTicker(interval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				check, cancel := context.WithTimeout(ctx, 5*time.Second)
				err := sample(check)
				cancel()
				if err != nil && ctx.Err() == nil {
					result <- err
					stop()
					return
				}
			}
		}
	}()
	return result
}

// Recent Buildx renamed --keep-storage to --max-used-space. Support either
// spelling while applying the same LRU cache limit.
func pruneCache(run func(...string) ([]byte, error), builder string, budget int64) error {
	help, err := run("buildx", "prune", "--help")
	if err != nil {
		return err
	}
	flag := "--keep-storage"
	if strings.Contains(string(help), "--max-used-space") {
		flag = "--max-used-space"
	}
	_, err = run("buildx", "prune", "--builder", builder, "--all", "--force", flag, fmt.Sprintf("%dB", budget))
	return err
}
