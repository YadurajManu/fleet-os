//go:build windows

package upgrade

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// The helper is a distinct executable: neither its image nor the service's
// running image is overwritten. It waits for the parent to terminate first.
func installForPlatform(staged, self string) (bool, error) {
	body, err := os.ReadFile(staged)
	if err != nil {
		return false, err
	}
	if len(body) < 2 || string(body[:2]) != "MZ" {
		return false, fmt.Errorf("staged Windows agent is not a PE executable")
	}
	helper := filepath.Join(filepath.Dir(staged), "agent-update-helper.exe")
	if err = os.WriteFile(helper, body, 0700); err != nil {
		return false, err
	}
	cmd := exec.Command(helper, "--apply-agent-update", self, "--update-parent", strconv.Itoa(os.Getpid()), "--update-staged", staged)
	if err = cmd.Start(); err != nil {
		return false, err
	}
	_ = cmd.Process.Release()
	return true, nil
}
func RunHelper(args []string) (bool, error) {
	if len(args) == 0 || args[0] != "--apply-agent-update" {
		return false, nil
	}
	if len(args) != 6 || args[2] != "--update-parent" || args[4] != "--update-staged" {
		return true, fmt.Errorf("invalid update helper arguments")
	}
	target, staged := args[1], args[5]
	if !filepath.IsAbs(target) || !filepath.IsAbs(staged) {
		return true, fmt.Errorf("update paths must be absolute")
	}
	pid, err := strconv.Atoi(args[3])
	if err != nil || pid <= 0 {
		return true, fmt.Errorf("invalid parent PID")
	}
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err == nil {
		event, waitErr := windows.WaitForSingleObject(process, 60000)
		_ = windows.CloseHandle(process)
		if waitErr != nil || event != windows.WAIT_OBJECT_0 {
			return true, fmt.Errorf("agent did not exit before update")
		}
	}
	// Wait for the Service Control Manager to finish its stop transition.
	time.Sleep(time.Second)
	body, err := os.ReadFile(staged)
	if err != nil {
		return true, err
	}
	next, backup := target+".new.exe", target+".previous.exe"
	if err = os.WriteFile(next, body, 0755); err != nil {
		return true, err
	}
	_ = os.Remove(backup)
	if err = os.Rename(target, backup); err != nil {
		_ = os.Remove(next)
		return true, err
	}
	if err = os.Rename(next, target); err != nil {
		_ = os.Rename(backup, target)
		return true, err
	}
	_ = os.Remove(staged)
	// The installer configures delayed SCM recovery as a backstop. Never
	// launch an unconfigured interactive agent if the service cannot start.
	if err = exec.Command("sc.exe", "start", "FleetAgent").Run(); err != nil {
		return true, fmt.Errorf("updated binary installed; restart FleetAgent service: %w", err)
	}
	return true, nil
}
