//go:build !windows

package terminal

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

type unixSession struct {
	id     string
	cmd    *exec.Cmd
	ptmx   *os.File
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
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}

	shell := requestedShell
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		for _, s := range []string{"/bin/zsh", "/bin/bash", "/bin/sh"} {
			if _, err := os.Stat(s); err == nil {
				shell = s
				break
			}
		}
	}
	if shell == "" {
		shell = "/bin/sh"
	}

	cmd := exec.Command(shell, "-l")
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"LANG=en_US.UTF-8",
	)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
	if err != nil {
		return nil, err
	}

	sess := &unixSession{
		id:   id,
		cmd:  cmd,
		ptmx: ptmx,
		log:  log,
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
			n, err := ptmx.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				onData(chunk)
			}
			if err != nil {
				if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
					log.Debug("ptmx read ended", "sessionId", id, "err", err)
				}
				return
			}
		}
	}()

	return sess, nil
}

func (s *unixSession) Write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ptmx == nil {
		return errors.New("terminal session closed")
	}
	_, err := s.ptmx.Write(data)
	return err
}

func (s *unixSession) Resize(cols, rows uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ptmx == nil {
		return nil
	}
	return pty.Setsize(s.ptmx, &pty.Winsize{
		Rows: rows,
		Cols: cols,
	})
}

func (s *unixSession) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true

	if s.ptmx != nil {
		_ = s.ptmx.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		// Attempt clean terminate, then kill
		_ = s.cmd.Process.Signal(syscall.SIGTERM)
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	return nil
}
