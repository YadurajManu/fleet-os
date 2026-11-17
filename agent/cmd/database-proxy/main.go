package main

import (
	"context"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/dbproxy"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var err error
	switch {
	case len(os.Args) == 3 && os.Args[1] == "cancel":
		err = dbproxy.CancelSession(ctx, os.Args[2])
	case len(os.Args) >= 5 && os.Args[1] == "exec":
		seconds, parseErr := strconv.Atoi(os.Args[3])
		if parseErr != nil || seconds < 1 || seconds > 3600 {
			os.Exit(2)
		}
		ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
		defer cancel()
		err = dbproxy.Session(ctx, os.Args[2], os.Args[4:], os.Stdin, os.Stdout, os.Stderr)
	case len(os.Args) == 2:
		port, parseErr := strconv.Atoi(os.Args[1])
		if parseErr != nil {
			os.Exit(2)
		}
		ctx, cancel := context.WithTimeout(ctx, time.Hour)
		defer cancel()
		err = dbproxy.Run(ctx, port, os.Stdin, os.Stdout)
	default:
		os.Exit(2)
	}
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() > 0 {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}
