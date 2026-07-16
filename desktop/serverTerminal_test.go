package main

import (
	"reflect"
	"testing"
)

func TestTerminalEnvironmentReplacesTerminalCapabilities(t *testing.T) {
	got := terminalEnvironment([]string{
		"PATH=/usr/bin:/bin",
		"TERM=dumb",
		"COLORTERM=old-value",
		"LANG=en_US.UTF-8",
	})
	want := []string{
		"PATH=/usr/bin:/bin",
		"LANG=en_US.UTF-8",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("terminalEnvironment() = %#v, want %#v", got, want)
	}
}
