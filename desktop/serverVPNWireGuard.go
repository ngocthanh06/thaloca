package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// wireGuardEngine implements vpnEngine for WireGuard, shelling out to the
// user-installed wg-quick (`brew install wireguard-tools`, which the engine
// picker offers as a one-click install — see ListVPNEngines). That formula
// also brings in wg-quick's own dependencies: wg, wireguard-go, and a
// modern GNU bash (macOS's /bin/bash is stuck on 3.2, too old for the
// `declare -A` wg-quick requires).
type wireGuardEngine struct{}

func (wireGuardEngine) kind() string { return "wireguard" }
func (wireGuardEngine) name() string { return "WireGuard" }

// binary is the engine's primary command name — the installSpecs key the
// frontend's one-click install uses. Installed-ness is probed via
// vpnEnginePrograms/vpnEngineInstalled, which also covers wg-quick's
// wg/wireguard-go/bash dependencies.
func (wireGuardEngine) binary() string { return "wg-quick" }

// wireGuardRootUnsafeKeys are wg-quick config keys that execute shell
// commands (PreUp/PostUp/PreDown/PostDown) or write files (SaveConfig) as
// root when the tunnel goes up or down. save() below never emits them, so
// any appearance means the on-disk .conf was edited outside Thaloca —
// refuse to hand it to root. Mirrors openVPNRootUnsafeDirectives.
var wireGuardRootUnsafeKeys = map[string]struct{}{
	"preup":      {},
	"postup":     {},
	"predown":    {},
	"postdown":   {},
	"saveconfig": {},
}

// validateWireGuardConfig re-checks a .conf at connect/disconnect time —
// not just at save — so a config rewritten on disk after Save can't smuggle
// exec directives into the root-privileged wg-quick run.
func validateWireGuardConfig(config string) error {
	for lineNumber, raw := range strings.Split(config, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "[") {
			continue
		}
		key, _, _ := strings.Cut(line, "=")
		key = strings.ToLower(strings.TrimSpace(key))
		if _, unsafe := wireGuardRootUnsafeKeys[key]; unsafe {
			return fmt.Errorf("WireGuard config line %d uses %q, which is not allowed because the tunnel runs with administrator privileges", lineNumber+1, key)
		}
	}
	return nil
}

func (wireGuardEngine) fields() []VPNFieldDef {
	return []VPNFieldDef{
		{Key: "privateKey", Label: "Private key", Placeholder: "This device's WireGuard private key", Secret: true, Required: true, Span: "wide"},
		{Key: "address", Label: "Address", Placeholder: "e.g. 10.0.0.2/32", Required: true, Span: "half"},
		{Key: "dns", Label: "DNS (optional)", Placeholder: "e.g. 1.1.1.1", Span: "half"},
		{Key: "publicKey", Label: "Peer public key", Placeholder: "The VPN server's public key", Required: true, Span: "wide"},
		{Key: "endpoint", Label: "Endpoint", Placeholder: "e.g. vpn.example.com:51820", Required: true, Span: "half"},
		{Key: "allowedIPs", Label: "Allowed IPs", Placeholder: "e.g. 0.0.0.0/0", Required: true, Span: "half"},
		{Key: "presharedKey", Label: "Preshared key (optional)", Secret: true, Span: "wide"},
		{Key: "keepalive", Label: "Persistent keepalive, seconds (optional)", Placeholder: "e.g. 25", Span: "narrow"},
	}
}

func (wireGuardEngine) confPath(serverID string) (string, error) {
	dir, err := vpnDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, vpnFileBase(serverID)+".conf"), nil
}

// save assembles values into a standard WireGuard .conf and writes it at
// 0600 — the same permissions saveServers() uses for servers.json, since
// this file holds equally sensitive material (a WireGuard private key).
func (e wireGuardEngine) save(serverID string, values map[string]string) error {
	for _, key := range []string{"privateKey", "address", "publicKey", "endpoint", "allowedIPs"} {
		if strings.TrimSpace(values[key]) == "" {
			return fmt.Errorf("missing required WireGuard field: %s", key)
		}
	}
	// Every field becomes one line of the .conf — a value with an embedded
	// newline could otherwise inject extra directives (PostUp, ...) that
	// validateWireGuardConfig exists to keep out.
	for key, value := range values {
		if strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("WireGuard field %s must be a single line", key)
		}
	}
	lines := []string{"[Interface]", "PrivateKey = " + values["privateKey"], "Address = " + values["address"]}
	if v := values["dns"]; v != "" {
		lines = append(lines, "DNS = "+v)
	}
	lines = append(lines, "", "[Peer]", "PublicKey = "+values["publicKey"])
	if v := values["presharedKey"]; v != "" {
		lines = append(lines, "PresharedKey = "+v)
	}
	lines = append(lines, "Endpoint = "+values["endpoint"], "AllowedIPs = "+values["allowedIPs"])
	if v := values["keepalive"]; v != "" {
		lines = append(lines, "PersistentKeepalive = "+v)
	}
	config := strings.Join(lines, "\n") + "\n"

	dir, err := vpnDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path, err := e.confPath(serverID)
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(config), 0o600)
}

func (e wireGuardEngine) configured(serverID string) bool {
	path, err := e.confPath(serverID)
	if err != nil {
		return false
	}
	_, statErr := os.Stat(path)
	return statErr == nil
}

// connected resolves the tunnel's real utun interface through wg-quick's
// own name file (/var/run/wireguard/<label>.name — wg-quick down removes
// it) and checks that interface actually exists. Deliberately does NOT run
// `wg show`: the tunnel was created by root, wireguard-go's UAPI socket is
// root-only, so an unprivileged `wg show` always fails and would report
// every live tunnel as down — silently bypassing the remove guards in
// RemoveServerVPNConfig/RemoveServer that rely on this.
func (e wireGuardEngine) connected(serverID string) bool {
	nameFile := "/var/run/wireguard/" + vpnFileBase(serverID) + ".name"
	data, err := os.ReadFile(nameFile)
	if err != nil {
		if _, statErr := os.Stat(nameFile); statErr != nil {
			return false
		}
		// The name file exists but isn't readable (a tunnel brought up before
		// connect() started chmod-ing it to 644). Assume connected — the safe
		// direction for the remove guards above.
		return true
	}
	iface := strings.TrimSpace(string(data))
	if iface == "" {
		return false
	}
	if _, err := os.Stat("/var/run/wireguard/" + iface + ".sock"); err != nil {
		return false
	}
	_, err = net.InterfaceByName(iface)
	return err == nil
}

// connect stages the Homebrew-installed bash/wg-quick/wg/wireguard-go
// (resolved into their kegs and hashed first — see vpnStagedExecutables)
// and this server's .conf into the root-owned run dir — every copy
// hash-verified there, see vpnStageScript — then runs wg-quick up from
// those copies. Root never executes or reads anything under a
// user-writable directory, so a same-user process can't swap a program or
// the config while the admin password dialog is open. wg-quick is invoked
// as an explicit argument to the staged GNU bash (its `#!/usr/bin/env
// bash` shebang would resolve to macOS's bash 3.2, too old for the
// `declare -A` wg-quick requires), and wg-quick itself prepends its own
// directory — the run dir — to PATH, which is where it then finds the
// staged wg and wireguard-go.
func (e wireGuardEngine) connect(serverID string) error {
	script, base, runDir, err := e.stagedScript(serverID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := script +
		// On a failed up, remove the run dir again: the .conf copy in it holds
		// the private key, and nothing is left running that needs the files.
		"; " + escapeOsascriptShellArg(runDir+"/bash") + " " + escapeOsascriptShellArg(runDir+"/wg-quick") + " up " + escapeOsascriptShellArg(runDir+"/"+base+".conf") + " || { s=$?; rm -rf " + escapeOsascriptShellArg(runDir) + "; exit $s; }" +
		// wireguard-go writes the label→utun name file readable only by root;
		// open it up so connected() can resolve the interface unprivileged.
		"; chmod 644 " + escapeOsascriptShellArg("/var/run/wireguard/"+base+".name") + " 2>/dev/null || true"
	return runPrivileged(ctx, cmd, "wg-quick up")
}

// disconnect tears down with exactly the files connect staged: root-owned
// since then (unforgeable) and guaranteed to describe the tunnel that is
// actually up — even if the copy under the user's home was edited or
// deleted meanwhile, wg-quick down still undoes the right routes/DNS/
// interface. Only if the run dir is gone (e.g. /var/run cleared) does it
// re-stage from the saved config. Afterwards the whole run dir is removed —
// the tunnel is down, and the staged .conf holds the private key.
func (e wireGuardEngine) disconnect(serverID string) error {
	base := vpnFileBase(serverID)
	runDir := vpnRunDir(serverID)
	stagedConf := runDir + "/" + base + ".conf"
	down := escapeOsascriptShellArg(runDir+"/bash") + " " + escapeOsascriptShellArg(runDir+"/wg-quick") + " down " + escapeOsascriptShellArg(stagedConf) +
		"; rm -rf " + escapeOsascriptShellArg(runDir)
	var cmd string
	if _, err := os.Stat(stagedConf); err == nil {
		cmd = "set -e; " + down
	} else {
		script, _, _, stageErr := e.stagedScript(serverID)
		if stageErr != nil {
			return stageErr
		}
		cmd = script + "; " + down
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return runPrivileged(ctx, cmd, "wg-quick down")
}

// stagedScript reads and validates this server's .conf, then builds the
// privileged staging preamble both connect and disconnect share.
func (e wireGuardEngine) stagedScript(serverID string) (script, base, runDir string, err error) {
	path, err := e.confPath(serverID)
	if err != nil {
		return "", "", "", err
	}
	conf, err := os.ReadFile(path)
	if err != nil {
		return "", "", "", fmt.Errorf("no VPN config saved for this server yet")
	}
	if err := validateWireGuardConfig(string(conf)); err != nil {
		return "", "", "", err
	}
	files, err := vpnStagedExecutables(e.kind())
	if err != nil {
		return "", "", "", err
	}
	base = vpnFileBase(serverID)
	files = append(files, vpnStagedFile{src: path, dest: base + ".conf", sha256: sha256Hex(conf), mode: "600"})
	runDir = vpnRunDir(serverID)
	return vpnStageScript(runDir, files), base, runDir, nil
}
