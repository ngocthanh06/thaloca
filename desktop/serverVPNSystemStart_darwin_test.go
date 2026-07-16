//go:build darwin && cgo

package main

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestStartSystemVPNRejectsEmptyServiceID(t *testing.T) {
	if err := startSystemVPN("  "); err == nil {
		t.Fatal("expected an empty service ID to be rejected")
	}
}

// TestSystemVPNNativeSmoke is opt-in because it briefly changes the Mac's
// system-wide network connection. It exercises the native start path against
// a real service while keeping ordinary unit-test runs side-effect free.
func TestSystemVPNNativeSmoke(t *testing.T) {
	serviceID := os.Getenv("THALOCA_SYSTEM_VPN_SMOKE_ID")
	if serviceID == "" {
		t.Skip("set THALOCA_SYSTEM_VPN_SMOKE_ID to test a real macOS VPN service")
	}

	status, err := systemVPNStatus(serviceID)
	if err != nil {
		t.Fatalf("read initial VPN status: %v", err)
	}
	if status != "Disconnected" {
		t.Fatalf("refusing to change VPN already in state %q", status)
	}

	if err := startSystemVPN(serviceID); err != nil {
		t.Fatalf("start VPN with saved defaults: %v", err)
	}
	defer func() {
		if out, err := exec.Command("scutil", "--nc", "stop", serviceID).CombinedOutput(); err != nil {
			t.Errorf("stop VPN after smoke test: %v: %s", err, out)
		}
	}()

	deadline := time.Now().Add(30 * time.Second)
	sawAttempt := false
	for time.Now().Before(deadline) {
		status, err = systemVPNStatus(serviceID)
		if err != nil {
			t.Fatalf("poll VPN status: %v", err)
		}
		if status == "Connected" {
			return
		}
		if status == "Disconnected" && sawAttempt {
			t.Fatal("VPN returned to Disconnected before connecting")
		}
		if status != "Disconnected" {
			sawAttempt = true
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("VPN did not connect within 30 seconds; last status %q", status)
}
