package main

import (
	"os"
	"testing"
)

func TestIsSafeSSHArg(t *testing.T) {
	cases := map[string]bool{
		"example.com":           true,
		"192.168.1.1":           true,
		"ubuntu":                true,
		"-oProxyCommand=evil":   false,
		"-":                     false,
		"":                      false,
		"--":                    false,
		"user-with-dash-inside": true,
	}
	for input, want := range cases {
		if got := isSafeSSHArg(input); got != want {
			t.Errorf("isSafeSSHArg(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestAddServerRejectsUnsafeHostOrUser(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := &App{}
	keyFile := t.TempDir() + "/key.pem"
	if err := os.WriteFile(keyFile, []byte("fake key"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := app.AddServer("test", "-oProxyCommand=evil", 22, "ubuntu", keyFile, ""); err == nil {
		t.Error("expected AddServer to reject a host starting with '-'")
	}
	if _, err := app.AddServer("test", "example.com", 22, "-oProxyCommand=evil", keyFile, ""); err == nil {
		t.Error("expected AddServer to reject a user starting with '-'")
	}
	if _, err := app.AddServer("test", "example.com", 22, "ubuntu", keyFile, ""); err != nil {
		t.Errorf("expected a normal host/user to be accepted, got: %v", err)
	}
}
