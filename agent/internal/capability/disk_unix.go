//go:build !windows

package capability

import (
	"golang.org/x/sys/unix"
	"syscall"
)

func freeDiskMb(path string) int {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0
	}
	return int((uint64(fs.Bavail) * uint64(fs.Bsize)) / (1024 * 1024))
}

func HostDisk(path string) (free, total int64, err error) {
	var stat unix.Statfs_t
	err = unix.Statfs(path, &stat)
	return int64(stat.Bavail) * int64(stat.Bsize), int64(stat.Blocks) * int64(stat.Bsize), err
}
