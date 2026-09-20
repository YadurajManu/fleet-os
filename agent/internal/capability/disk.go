package capability

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// DiskBudget keeps both the host and the Linux engine above their own reserve.
type DiskBudget struct{ Free, Reserve int64 }

func DiskHeadroom(hostFree, hostTotal, engineFree, engineTotal, minimumReserve int64) DiskBudget {
	hostReserve := max(minimumReserve, hostTotal/10)
	engineReserve := max(minimumReserve, engineTotal/10)
	if hostFree-hostReserve < engineFree-engineReserve {
		return DiskBudget{hostFree, hostReserve}
	}
	return DiskBudget{engineFree, engineReserve}
}
func ParseDisk(body []byte) (free, total int64, err error) {
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 4 {
		return 0, 0, fmt.Errorf("cannot read Docker engine disk space")
	}
	total, err = strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	free, err = strconv.ParseInt(fields[3], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	if total <= 0 || free < 0 {
		return 0, 0, fmt.Errorf("invalid Docker engine disk space")
	}
	return free * 1024, total * 1024, nil
}
func ProbeDisk(ctx context.Context, path string, reserve int64, builder string) (DiskBudget, error) {
	hostFree, hostTotal, err := HostDisk(path)
	if err != nil {
		return DiskBudget{}, err
	}
	var args []string
	if builder != "" {
		args = []string{"exec", "buildx_buildkit_" + builder + "0", "df", "-Pk", "/var/lib/buildkit"}
	} else {
		// Runs a trusted read-only utility in the engine VM; never mounts the host or Docker socket.
		args = []string{"run", "--rm", "--network=none", "--read-only", "--entrypoint", "df", "moby/buildkit:buildx-stable-1", "-Pk", "/"}
	}
	out, err := DockerCommand(ctx, args...).Output()
	if err != nil {
		return DiskBudget{}, fmt.Errorf("cannot measure Docker engine disk space: %w", err)
	}
	engineFree, engineTotal, err := ParseDisk(out)
	if err != nil {
		return DiskBudget{}, err
	}
	return DiskHeadroom(hostFree, hostTotal, engineFree, engineTotal, reserve), nil
}
func (d DiskBudget) Preflight(bytes int64) error {
	if d.Free-d.Reserve < bytes {
		return fmt.Errorf("insufficient disk space: %d bytes free; build needs %d bytes plus %d bytes reserve", d.Free, bytes, d.Reserve)
	}
	return nil
}
