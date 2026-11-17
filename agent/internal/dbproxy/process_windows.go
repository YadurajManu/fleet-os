package dbproxy

import "os/exec"

// The helper runs inside Linux containers, including on Windows Docker Desktop.
func configureProcessGroup(cmd *exec.Cmd) {}
