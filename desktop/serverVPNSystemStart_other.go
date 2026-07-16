//go:build !darwin || !cgo

package main

import "fmt"

func startSystemVPN(string) error {
	return fmt.Errorf("System VPN is only supported on macOS with cgo enabled")
}
