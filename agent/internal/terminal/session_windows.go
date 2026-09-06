//go:build windows

package terminal

import (
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"sync"
)

type windowsSession struct {
	id     string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	mu     sync.Mutex
	closed bool
	log    *slog.Logger
}

func startOSSession(
	id string,
	cols, rows uint16,
	requestedShell string,
	onData func([]byte),
	onExit func(),
	log *slog.Logger,
) (Session, error) {
	shell := requestedShell
	if shell == "" {
		shell = "powershell.exe"
	}

	cmd := exec.Command(shell)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	cmd.Stderr = cmd.Stdout

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}

	sess := &windowsSession{
		id:     id,
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		log:    log,
	}

	go func() {
		defer func() {
			_ = sess.Close()
			if onExit != nil {
				onExit()
			}
		}()

		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				onData(chunk)
			}
			if err != nil {
				return
			}
		}
	}()

	return sess, nil
}

func (s *windowsSession) Write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.stdin == nil {
		return errors.New("terminal session closed")
	}
	_, err := s.stdin.Write(data)
	return err
}

func (s *windowsSession) Resize(cols, rows uint16) error {
	// Standard Windows pipe cannot resize without ConPTY
	return nil
}

func (s *windowsSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true

	if s.stdin != nil {
		_ = s.stdin.Close()
	}
	if s.stdout != nil {
		_ = s.stdout.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	return nil
}
