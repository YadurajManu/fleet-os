//go:build !windows

package main

import "context"

func dispatchService() bool                     { return false }
func serviceStopHook(cancel context.CancelFunc) {}
