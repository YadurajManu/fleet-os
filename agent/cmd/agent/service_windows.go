//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/windows/svc"
	"os"
	"sync"
)

var stopMu sync.Mutex
var serviceCancel context.CancelFunc
var serviceStopping bool

func serviceStopHook(cancel context.CancelFunc) {
	stopMu.Lock()
	defer stopMu.Unlock()
	serviceCancel = cancel
	if serviceStopping {
		cancel()
	}
}
func dispatchService() bool {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false
	}
	if err = svc.Run("FleetAgent", agentService{}); err != nil {
		fmt.Fprintln(os.Stderr, "FleetAgent service:", err)
	}
	return true
}

type agentService struct{}

func (agentService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	result := make(chan error, 1)
	go func() { result <- run() }()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-result:
			if err != nil && !errors.Is(err, context.Canceled) {
				return true, 1
			}
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				stopMu.Lock()
				serviceStopping = true
				if serviceCancel != nil {
					serviceCancel()
				}
				stopMu.Unlock()
			}
		}
	}
}
