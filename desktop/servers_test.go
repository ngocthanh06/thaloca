package main

import (
	"os"
	"path/filepath"
	"strings"
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

	if _, err := app.AddServer("test", "-oProxyCommand=evil", 22, "ubuntu", keyFile, "", ""); err == nil {
		t.Error("expected AddServer to reject a host starting with '-'")
	}
	if _, err := app.AddServer("test", "example.com", 22, "-oProxyCommand=evil", keyFile, "", ""); err == nil {
		t.Error("expected AddServer to reject a user starting with '-'")
	}
	if _, err := app.AddServer("test", "example.com", 22, "ubuntu", keyFile, "", "-oProxyCommand=evil"); err == nil {
		t.Error("expected AddServer to reject a proxy jump starting with '-'")
	}
	if _, err := app.AddServer("test", "example.com", 22, "ubuntu", keyFile, "", ""); err != nil {
		t.Errorf("expected a normal host/user to be accepted, got: %v", err)
	}
}

func TestSSHBaseArgsIncludesProxyJumpOnlyWhenSet(t *testing.T) {
	direct := sshBaseArgs(ServerConnection{Host: "example.com", User: "ubuntu", Port: 22, KeyPath: "/key"})
	if strings.Contains(strings.Join(direct, " "), "-J") {
		t.Errorf("expected no -J flag without ProxyJump, got args: %v", direct)
	}

	viaBastion := sshBaseArgs(ServerConnection{Host: "example.com", User: "ubuntu", Port: 22, KeyPath: "/key", ProxyJump: "jump@bastion.example.com"})
	joined := strings.Join(viaBastion, " ")
	if !strings.Contains(joined, "-J jump@bastion.example.com") {
		t.Errorf("expected -J jump@bastion.example.com in args, got: %v", viaBastion)
	}
}

func TestSetCronLineEnabled(t *testing.T) {
	raw := "# comment\n0 * * * * /bin/true\n# 30 * * * * /bin/false\n"

	disabled, err := setCronLineEnabled(raw, 2, false)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(disabled, "\n")
	if lines[1] != "# 0 * * * * /bin/true" {
		t.Errorf("expected line 2 to be commented out, got: %q", lines[1])
	}
	if lines[0] != "# comment" || lines[2] != "# 30 * * * * /bin/false" {
		t.Errorf("expected other lines untouched, got: %v", lines)
	}

	enabled, err := setCronLineEnabled(raw, 3, true)
	if err != nil {
		t.Fatal(err)
	}
	lines = strings.Split(enabled, "\n")
	if lines[2] != "30 * * * * /bin/false" {
		t.Errorf("expected line 3 to be uncommented, got: %q", lines[2])
	}

	if _, err := setCronLineEnabled(raw, 99, false); err == nil {
		t.Error("expected out-of-range line to error")
	}
}

func TestRemoveCronLine(t *testing.T) {
	raw := "0 * * * * /bin/true\n30 * * * * /bin/false\n"
	updated, err := removeCronLine(raw, 1)
	if err != nil {
		t.Fatal(err)
	}
	if updated != "30 * * * * /bin/false\n" {
		t.Errorf("expected first line removed, got: %q", updated)
	}

	if _, err := removeCronLine(raw, 0); err == nil {
		t.Error("expected line 0 to error (1-indexed)")
	}
}

func TestListSSHConfigHostsSkipsWildcardsAndExpandsTilde(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	config := "" +
		"Host myserver\n" +
		"    HostName 1.2.3.4\n" +
		"    User ubuntu\n" +
		"    Port 2222\n" +
		"    IdentityFile ~/.ssh/id_rsa\n" +
		"    ProxyJump jump@bastion.example.com\n" +
		"\n" +
		"Host *\n" +
		"    ServerAliveInterval 60\n"
	if err := os.WriteFile(filepath.Join(sshDir, "config"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	app := &App{}
	hosts, err := app.ListSSHConfigHosts()
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 1 {
		t.Fatalf("expected exactly 1 non-wildcard host, got %d: %v", len(hosts), hosts)
	}
	got := hosts[0]
	want := SSHConfigHost{
		Alias: "myserver", Host: "1.2.3.4", Port: 2222, User: "ubuntu",
		KeyPath: filepath.Join(home, ".ssh", "id_rsa"), ProxyJump: "jump@bastion.example.com",
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestListSSHConfigHostsMissingFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := &App{}
	hosts, err := app.ListSSHConfigHosts()
	if err != nil {
		t.Fatal(err)
	}
	if hosts != nil {
		t.Errorf("expected nil hosts when ~/.ssh/config doesn't exist, got: %v", hosts)
	}
}
