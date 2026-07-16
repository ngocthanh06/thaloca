package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// openVPNEngine implements vpnEngine for OpenVPN. Like WireGuard, it never
// shells out to a system-installed openvpn — the binary (and its relocated
// lzo/lz4/openssl/pkcs11-helper dylib dependencies) is bundled inside
// Thaloca itself (see vpnbin.go) and extracted to vpnBinDir() on demand.
type openVPNEngine struct{}

// openVPNSafeDirectives is an allowlist of client-only options that neither
// execute/load code nor read/write an arbitrary local path. OpenVPN is run as
// root, so a denylist is not a safe boundary: new and easy-to-miss options
// such as `providers /tmp/module.dylib` can load code before privileges are
// dropped. Unsupported configs fail closed with the exact line reported.
var openVPNSafeDirectives = map[string]struct{}{
	"allow-compression": {}, "auth": {}, "auth-nocache": {}, "auth-retry": {}, "auth-user-pass": {},
	"bind": {}, "block-ipv6": {}, "block-outside-dns": {}, "cipher": {}, "client": {}, "comp-lzo": {}, "compress": {},
	"connect-retry": {}, "connect-retry-max": {}, "connect-timeout": {}, "data-ciphers": {}, "data-ciphers-fallback": {},
	"dev": {}, "dev-type": {}, "dhcp-option": {}, "dns": {}, "explicit-exit-notify": {}, "fast-io": {}, "float": {},
	"fragment": {}, "hand-window": {}, "http-proxy": {}, "http-proxy-option": {}, "http-proxy-retry": {}, "inactive": {},
	"ip-win32": {}, "keepalive": {}, "key-direction": {}, "link-mtu": {}, "local": {}, "lport": {}, "mark": {},
	"max-routes": {}, "mssfix": {}, "mute": {}, "mute-replay-warnings": {}, "nobind": {}, "passtos": {},
	"peer-fingerprint": {}, "persist-key": {}, "persist-local-ip": {}, "persist-remote-ip": {}, "persist-tun": {},
	"ping": {}, "ping-exit": {}, "ping-restart": {}, "ping-timer-rem": {}, "port": {}, "proto": {}, "proto-force": {},
	"pull": {}, "pull-filter": {}, "rcvbuf": {}, "redirect-gateway": {}, "redirect-private": {}, "register-dns": {},
	"remote": {}, "remote-cert-eku": {}, "remote-cert-ku": {}, "remote-cert-tls": {}, "remote-random": {},
	"remote-random-hostname": {}, "reneg-bytes": {}, "reneg-pkts": {}, "reneg-sec": {}, "resolv-retry": {},
	"route": {}, "route-delay": {}, "route-gateway": {}, "route-ipv6": {}, "route-metric": {}, "route-noexec": {},
	"route-nopull": {}, "server-poll-timeout": {}, "setenv": {}, "setenv-safe": {}, "sndbuf": {}, "socket-flags": {},
	"static-challenge": {}, "tcp-nodelay": {}, "tls-cert-profile": {}, "tls-cipher": {}, "tls-ciphersuites": {},
	"tls-client": {}, "tls-exit": {}, "tls-groups": {}, "tls-timeout": {}, "tls-version-max": {}, "tls-version-min": {},
	"topology": {}, "tran-window": {}, "tun-mtu": {}, "tun-mtu-extra": {}, "verb": {}, "verify-hash": {},
	"verify-x509-name": {}, "x509-track": {}, "x509-username-field": {},
}

// These file-valued options are accepted only in OpenVPN's inline form.
// Their contents are data inside the staged .ovpn itself; accepting a path
// argument would instead let root read an arbitrary file from the Mac.
var openVPNSafeInlineBlocks = map[string]struct{}{
	"auth-user-pass": {}, "ca": {}, "cert": {}, "crl-verify": {}, "extra-certs": {},
	"key": {}, "peer-fingerprint": {}, "pkcs12": {}, "tls-auth": {}, "tls-crypt": {},
	"tls-crypt-v2": {}, "verify-hash": {},
}

func (openVPNEngine) kind() string { return "openvpn" }
func (openVPNEngine) name() string { return "OpenVPN" }

// binary returns the bundled openvpn's full path (extracting it and its
// dylib dependencies first if needed), not just "openvpn" — there is
// deliberately nothing on the system PATH for this engine to depend on.
func (openVPNEngine) binary() string {
	dir, err := vpnBinDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "openvpn")
}

func (openVPNEngine) fields() []VPNFieldDef {
	return []VPNFieldDef{
		{Key: "ovpnConfig", Label: "OpenVPN config (.ovpn)", Placeholder: "Paste the full .ovpn file contents for this server…", Required: true, Multiline: true, Span: "wide"},
		{Key: "username", Label: "Username (optional)", Placeholder: "Only if this .ovpn requires login", Span: "half"},
		{Key: "password", Label: "Password (optional)", Secret: true, Span: "half"},
	}
}

// paths returns every file this engine uses for one server. The config and
// credentials live under vpnDir() (user-owned; RemoveServerVPNConfig's glob
// cleanup catches them by basename), but the pid and log files root-owned
// OpenVPN writes live under the server's root-owned run dir — if root wrote
// them into the user-writable vpnDir(), a symlink planted at those paths
// would let any same-user process make root overwrite an arbitrary file.
func (openVPNEngine) paths(serverID string) (ovpn, auth, pid, log string, err error) {
	dir, err := vpnDir()
	if err != nil {
		return
	}
	base := filepath.Join(dir, vpnFileBase(serverID))
	run := filepath.Join(vpnRunDir(serverID), vpnFileBase(serverID))
	return base + ".ovpn", base + ".auth", run + ".pid", run + ".log", nil
}

func (e openVPNEngine) save(serverID string, values map[string]string) error {
	config := strings.TrimSpace(values["ovpnConfig"])
	if config == "" {
		return fmt.Errorf("OpenVPN config is empty")
	}
	if err := validateOpenVPNConfig(config); err != nil {
		return err
	}
	dir, err := vpnDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	ovpnPath, authPath, _, _, err := e.paths(serverID)
	if err != nil {
		return err
	}
	if err := os.WriteFile(ovpnPath, []byte(config+"\n"), 0o600); err != nil {
		return err
	}

	username := strings.TrimSpace(values["username"])
	password := values["password"]
	if username != "" || password != "" {
		if err := os.WriteFile(authPath, []byte(username+"\n"+password+"\n"), 0o600); err != nil {
			return err
		}
	} else {
		// No credentials this time — remove any stale ones from a prior
		// save so connect() doesn't pass a leftover --auth-user-pass file.
		_ = os.Remove(authPath)
	}
	return nil
}

// validateOpenVPNConfig accepts only the client options above. Both
// "directive value" and "--directive=value" forms are understood so syntax
// variations cannot bypass the allowlist.
func validateOpenVPNConfig(config string) error {
	inlineBlock := ""
	for lineNumber, raw := range strings.Split(config, "\n") {
		line := strings.TrimSpace(raw)
		if inlineBlock != "" {
			if strings.EqualFold(line, "</"+inlineBlock+">") {
				inlineBlock = ""
			}
			continue
		}
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "<") {
			if !strings.HasSuffix(line, ">") || strings.HasPrefix(line, "</") {
				return fmt.Errorf("OpenVPN config line %d has an invalid inline block marker", lineNumber+1)
			}
			name := strings.ToLower(strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "<"), ">")))
			if _, ok := openVPNSafeInlineBlocks[name]; !ok {
				return fmt.Errorf("OpenVPN config line %d uses unsupported inline block %q", lineNumber+1, name)
			}
			inlineBlock = name
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		token := strings.ToLower(strings.TrimLeft(fields[0], "-"))
		directive, inlineValue, _ := strings.Cut(token, "=")
		if _, safe := openVPNSafeDirectives[directive]; !safe {
			return fmt.Errorf("OpenVPN config line %d uses unsupported directive %q, which is not allowed because the VPN runs with administrator privileges", lineNumber+1, directive)
		}
		// A bare auth-user-pass is harmless (and Thaloca supplies its own staged
		// credential file when username/password were entered). A path argument
		// would let root read an arbitrary local file and send its contents to the
		// VPN server, so reject that form like the other file directives above.
		args := fields[1:]
		if inlineValue != "" {
			args = append([]string{inlineValue}, args...)
		}
		if directive == "auth-user-pass" && len(args) > 0 {
			return fmt.Errorf("OpenVPN config line %d must not supply an auth-user-pass file; enter credentials in Thaloca instead", lineNumber+1)
		}
		// http-proxy's optional third argument is normally a local file whose
		// first two lines OpenVPN reads as proxy credentials. Because this
		// process runs as root, accepting that form would let an imported config
		// read and send any root-readable file to an attacker-controlled proxy.
		// The only safe third-argument forms are OpenVPN's literal automatic
		// authentication modes; no fourth argument is valid with those forms.
		if directive == "http-proxy" && len(args) > 2 {
			mode := strings.ToLower(args[2])
			if len(args) != 3 || (mode != "auto" && mode != "auto-nct") {
				return fmt.Errorf("OpenVPN config line %d must not supply an HTTP proxy credential file; only auto or auto-nct authentication is allowed", lineNumber+1)
			}
		}
	}
	if inlineBlock != "" {
		return fmt.Errorf("OpenVPN config has an unterminated <%s> inline block", inlineBlock)
	}
	return nil
}

func (e openVPNEngine) configured(serverID string) bool {
	ovpnPath, _, _, _, err := e.paths(serverID)
	if err != nil {
		return false
	}
	_, statErr := os.Stat(ovpnPath)
	return statErr == nil
}

// connected reports whether the backgrounded openvpn process from a prior
// connect() is still alive AND its log shows a completed handshake — a PID
// merely existing isn't enough (it may still be retrying), and the log
// line alone isn't enough either (it persists after the process exits).
// "Alive" here means openVPNProcessMatches, not a bare kill-0 probe: after
// a crash the pid file lingers, and a kill-0 EPERM from an unrelated root
// process that recycled the PID would otherwise count as ours.
func (e openVPNEngine) connected(serverID string) bool {
	_, _, pidPath, logPath, err := e.paths(serverID)
	if err != nil {
		return false
	}
	pid, ok := readPID(pidPath)
	if !ok || !openVPNProcessMatches(pid, vpnRunDir(serverID)) {
		return false
	}
	logData, err := os.ReadFile(logPath)
	if err != nil {
		return false
	}
	return strings.Contains(string(logData), "Initialization Sequence Completed")
}

// openVPNProcessMatches reports whether pid is alive and really is the
// staged openvpn launched from this server's run dir, by checking the
// process's command line for the run dir path (unique per server, root-only
// writable, and present in every argument connect() passes).
func openVPNProcessMatches(pid int, runDir string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), runDir+"/")
}

// connect stages the bundled openvpn (plus its dylibs) and this server's
// config/credentials into the root-owned run dir — hash-verified there, see
// vpnStageScript — then starts openvpn as a background daemon from those
// copies (admin privileges are needed to create the tun device, same as
// WireGuard's wg-quick — see ConnectServerVPN's doc comment). The .ovpn is
// re-validated here, not just at save: a config rewritten on disk after
// Save must not smuggle exec directives into the root-privileged run. It
// then briefly polls the log for a real completion signal, since `openvpn
// --daemon` returns almost immediately, well before the handshake finishes.
func (e openVPNEngine) connect(serverID string) error {
	ovpnPath, authPath, pidPath, logPath, err := e.paths(serverID)
	if err != nil {
		return err
	}
	config, err := os.ReadFile(ovpnPath)
	if err != nil {
		return fmt.Errorf("no VPN config saved for this server yet")
	}
	if err := validateOpenVPNConfig(string(config)); err != nil {
		return err
	}
	// Refuse while already connected: staging recreates the run dir, which
	// would delete the live tunnel's pid file and orphan its root process.
	if e.connected(serverID) {
		return fmt.Errorf("this server's VPN is already connected")
	}

	files, err := vpnStagedBinaries("openvpn")
	if err != nil {
		return err
	}
	base := vpnFileBase(serverID)
	runDir := vpnRunDir(serverID)
	files = append(files, vpnStagedFile{src: ovpnPath, dest: base + ".ovpn", sha256: sha256Hex(config), mode: "600"})
	stagedOvpn := runDir + "/" + base + ".ovpn"
	authArg := ""
	if auth, readErr := os.ReadFile(authPath); readErr == nil {
		files = append(files, vpnStagedFile{src: authPath, dest: base + ".auth", sha256: sha256Hex(auth), mode: "600"})
		authArg = " --auth-user-pass " + escapeOsascriptShellArg(runDir+"/"+base+".auth")
	}

	cmd := vpnStageScript(runDir, files) + "; " +
		escapeOsascriptShellArg(runDir+"/openvpn") +
		" --config " + escapeOsascriptShellArg(stagedOvpn) +
		" --daemon --writepid " + escapeOsascriptShellArg(pidPath) +
		" --log " + escapeOsascriptShellArg(logPath) +
		authArg +
		// On a failed start, remove the run dir again: the staged config/auth
		// copies hold credentials, and no daemon is left that needs the files.
		" || { s=$?; rm -rf " + escapeOsascriptShellArg(runDir) + "; exit $s; }"

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := runPrivileged(ctx, cmd, "openvpn"); err != nil {
		return err
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, readErr := os.ReadFile(logPath); readErr == nil && strings.Contains(string(data), "Initialization Sequence Completed") {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	if e.connected(serverID) {
		return nil
	}
	return fmt.Errorf("openvpn started but hasn't finished connecting yet — check its status again shortly")
}

// disconnect kills the backgrounded openvpn process — needs admin
// privileges since the process was started as root. The privileged script
// re-reads the PID from the root-owned pid file itself and verifies the
// process's command line really is this server's staged openvpn before
// killing, so a PID recycled by an unrelated root process after a crash is
// never killed; a stale pid file is just cleaned up. Afterwards the whole
// root-owned run dir is removed — the staged config/auth copies hold
// credentials and nothing running needs them anymore.
func (e openVPNEngine) disconnect(serverID string) error {
	_, _, pidPath, _, err := e.paths(serverID)
	if err != nil {
		return err
	}
	if _, ok := readPID(pidPath); !ok {
		return fmt.Errorf("no running OpenVPN connection found for this server")
	}
	runDir := vpnRunDir(serverID)
	cleanup := "rm -rf " + escapeOsascriptShellArg(runDir)
	// No double quotes anywhere (see vpnStageScript): runPrivileged embeds
	// this in an AppleScript double-quoted string.
	script := "set -e" +
		"; pid=$(cat " + escapeOsascriptShellArg(pidPath) + ")" +
		"; case $pid in ''|*[!0-9]*) " + cleanup + "; exit 0;; esac" +
		"; if ps -p $pid -o command= | grep -qF " + escapeOsascriptShellArg(runDir+"/openvpn") + "; then kill $pid; fi" +
		"; " + cleanup
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return runPrivileged(ctx, script, "openvpn disconnect")
}

// readPID reads a PID written by `openvpn --writepid`, validating it's
// actually numeric.
func readPID(pidPath string) (int, bool) {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}
