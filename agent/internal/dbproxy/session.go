package dbproxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

var sessionID = regexp.MustCompile(`^[a-f0-9]{32}$`)

func sessionPath(id string) (string, error) {
	if !sessionID.MatchString(id) {
		return "", errors.New("invalid database session")
	}
	dir := filepath.Join("/tmp", fmt.Sprintf("fleet-db-sessions-%d", os.Getuid()))
	if os.MkdirAll(dir, 0700) != nil {
		return "", errors.New("session directory unavailable")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("session directory is not private")
	}
	return filepath.Join(dir, id+".sock"), nil
}

// Session gives Docker exec cancellation an explicit process-group lifetime.
func Session(ctx context.Context, id string, command []string, input io.Reader, output, stderr io.Writer) error {
	if len(command) == 0 {
		return errors.New("database session command missing")
	}
	socket, err := sessionPath(id)
	if err != nil {
		return err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return errors.New("database session unavailable")
	}
	defer listener.Close()
	defer os.Remove(socket)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			_ = conn.Close()
			cancel()
		}
	}()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = input, output, stderr
	cmd.WaitDelay = 2 * time.Second
	configureProcessGroup(cmd)
	return cmd.Run()
}

func CancelSession(ctx context.Context, id string) error {
	socket, err := sessionPath(id)
	if err != nil {
		return err
	}
	conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", socket)
	if err != nil {
		return errors.New("database session already closed or unavailable")
	}
	return conn.Close()
}
