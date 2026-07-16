package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// VPNFieldDef describes one input a VPN engine's guided setup form needs —
// returned to the frontend (via ListVPNEngines) so it can render each
// engine's fields generically instead of hardcoding one protocol's fields.
type VPNFieldDef struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder,omitempty"`
	Secret      bool   `json:"secret,omitempty"`
	Required    bool   `json:"required,omitempty"`
	Multiline   bool   `json:"multiline,omitempty"`
	// Span is a layout hint matching servers.ts's server-add-field-* grid
	// classes: "wide" (full row), "half" (2 of 4 columns), or "narrow" (1
	// of 4) — decided per engine here so the frontend renderer stays
	// generic across every VPN protocol instead of hardcoding one's layout.
	Span string `json:"span"`
}

// VPNEngineInfo is one supported VPN protocol's metadata: whether its CLI
// tool is currently installed, and which fields its guided setup form
// needs. The frontend's engine picker and field renderer are entirely
// data-driven from this — adding a new protocol later never requires
// frontend changes beyond what ListVPNEngines already returns. Binary and
// InstallCommand let the frontend offer a one-click install (via the
// existing RunToolAction job/confirm flow, same as the Tools tab) instead
// of just telling the user to go install it themselves.
type VPNEngineInfo struct {
	Kind           string        `json:"kind"`
	Name           string        `json:"name"`
	Installed      bool          `json:"installed"`
	Fields         []VPNFieldDef `json:"fields"`
	Binary         string        `json:"binary"`
	InstallCommand string        `json:"install_command,omitempty"`
}

// VPNStatus is one server's VPN tunnel state, regardless of engine.
// Configured (a config has been saved) is independent from Connected (the
// tunnel is actually up right now) — the same installed-vs-running split
// containerRuntime.go already uses for container engines.
type VPNStatus struct {
	Configured bool `json:"configured"`
	Connected  bool `json:"connected"`
}

// vpnEngine is implemented once per supported VPN protocol (see
// serverVPNWireGuard.go, serverVPNOpenVPN.go). Adding a new protocol later
// means adding one more implementation and a registry entry below —
// nothing else in this file, servers.go, or the frontend needs to change.
type vpnEngine interface {
	kind() string
	name() string
	binary() string
	fields() []VPNFieldDef
	save(serverID string, values map[string]string) error
	configured(serverID string) bool
	connected(serverID string) bool
	connect(serverID string) error
	disconnect(serverID string) error
}

var vpnEngines = map[string]vpnEngine{
	"wireguard": wireGuardEngine{},
	"openvpn":   openVPNEngine{},
}

// vpnEngineOrder is ListVPNEngines' fixed display order (map iteration
// order isn't stable).
var vpnEngineOrder = []string{"wireguard", "openvpn"}

// vpnDir is where every server's VPN config lives, one (or more) files per
// server — never inside servers.json itself, since a VPN config commonly
// holds a private key or password.
func vpnDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "vpn"), nil
}

// vpnFileBase derives a short, filesystem/interface-name-safe basename from
// a hash of the server ID, shared by every engine's own file(s) under vpnDir() (e.g.
// "<base>.conf" for WireGuard, "<base>.ovpn"/"<base>.pid" for OpenVPN).
// Kept short since wg-quick uses this basename as the tunnel's internal
// label, capped well under the traditional 16-byte BSD interface name
// limit.
func vpnFileBase(serverID string) string {
	// IDs normally come from AddServer, but servers.json is user-editable and
	// imported backups are external input. Never put the raw value in a path
	// later used by a root script: slashes/.. could otherwise escape vpnRunRoot.
	return "thal" + sha256Hex([]byte(serverID))[:10]
}

// vpnRunRoot is the parent of every server's root-owned VPN staging
// directory. It lives under /var/run — writable only by root and cleared on
// reboot — so no unprivileged process can pre-create, replace, or symlink
// anything along the path.
const vpnRunRoot = "/var/run/thaloca-vpn"

// vpnRunDir is one server's root-owned staging directory: everything root
// executes (bundled binaries) or reads (the VPN config) for this server's
// tunnel is copied here and hash-verified first, and OpenVPN's pid/log
// files are written here — never under the user-writable home directory.
func vpnRunDir(serverID string) string {
	return vpnRunRoot + "/" + vpnFileBase(serverID)
}

// vpnStagedFile is one file the privileged staging script copies into a
// server's run dir before executing anything from it. sha256 is the
// expected content hash — computed from trusted bytes (the embedded
// binaries, or config bytes this process just read and validated) — and is
// verified by root AFTER the copy lands in the root-owned directory, so a
// same-user process rewriting the user-writable source mid-flight (while
// the admin password dialog is open, say) can only make the connect abort,
// never get its bytes run as root.
type vpnStagedFile struct {
	src    string
	dest   string // path relative to the run dir ("wg", "lib/x.dylib", ...)
	sha256 string
	mode   string // chmod mode applied after verification
}

// vpnStageScript builds the shell fragment that recreates runDir root-owned,
// copies files into it, verifies each copy's SHA-256, and locks down modes.
// Deliberately written without double quotes anywhere: runPrivileged embeds
// the result inside an AppleScript double-quoted string literal.
func vpnStageScript(runDir string, files []vpnStagedFile) string {
	parts := []string{
		"set -e",
		"umask 022",
		"rm -rf " + escapeOsascriptShellArg(runDir),
		"mkdir -p " + escapeOsascriptShellArg(runDir+"/lib"),
	}
	for _, f := range files {
		dest := runDir + "/" + f.dest
		parts = append(parts,
			"cp "+escapeOsascriptShellArg(f.src)+" "+escapeOsascriptShellArg(dest),
			"h=$(/usr/bin/shasum -a 256 "+escapeOsascriptShellArg(dest)+")",
			"case $h in "+f.sha256+"*) ;; *) echo "+escapeOsascriptShellArg("integrity check failed for "+f.dest)+"; exit 70;; esac",
			"chmod "+f.mode+" "+escapeOsascriptShellArg(dest),
		)
	}
	return strings.Join(parts, "; ")
}

// vpnStagedBinaries builds staged-file entries for the named bundled
// binaries plus every bundled dylib (staged under lib/, where the binaries'
// rewritten @executable_path/lib load commands expect them), hashed from
// the embedded copies inside the app binary itself.
func vpnStagedBinaries(names ...string) ([]vpnStagedFile, error) {
	dir, err := vpnBinDir()
	if err != nil {
		return nil, err
	}
	var files []vpnStagedFile
	for _, name := range names {
		sum, err := embeddedSHA256(vpnBinSourceDir + "/" + name)
		if err != nil {
			return nil, err
		}
		files = append(files, vpnStagedFile{src: filepath.Join(dir, name), dest: name, sha256: sum, mode: "755"})
	}
	for _, lib := range vpnLibNames {
		sum, err := embeddedSHA256(vpnBinSourceDir + "/lib/" + lib)
		if err != nil {
			return nil, err
		}
		files = append(files, vpnStagedFile{src: filepath.Join(dir, "lib", lib), dest: "lib/" + lib, sha256: sum, mode: "755"})
	}
	return files, nil
}

// ListVPNEngines reports every supported VPN protocol, whether its CLI
// tool is currently installed, and the fields its guided setup form needs.
func (a *App) ListVPNEngines() []VPNEngineInfo {
	infos := make([]VPNEngineInfo, 0, len(vpnEngineOrder))
	for _, kind := range vpnEngineOrder {
		e := vpnEngines[kind]
		_, err := exec.LookPath(e.binary())
		info := VPNEngineInfo{Kind: e.kind(), Name: e.name(), Installed: err == nil, Fields: e.fields(), Binary: e.binary()}
		// installSpecs (toolActions.go) is keyed by binary name, which for
		// engines that still need a separate install (currently only
		// OpenVPN) is also the RunToolAction tool key the frontend passes to
		// install it — same table the Tools tab uses, so this stays in sync
		// without duplicating the brew formula/command here. WireGuard's
		// binary() is a full bundled path (see vpnbin.go) that never matches
		// a key in that map, so it never gets an InstallCommand here — it's
		// always Installed once vpnBinDir() has extracted it, which
		// exec.LookPath above (given an absolute path) confirms directly.
		if !info.Installed {
			if spec, ok := installSpecs[e.binary()]; ok {
				info.InstallCommand = spec.display()
			}
		}
		infos = append(infos, info)
	}
	return infos
}

// SetServerVPNConfig saves one server's VPN config through the named
// engine, then records which engine it used on the server itself. Refuses
// while the tunnel is connected — overwriting the config under a live
// tunnel means the later disconnect would tear down with the wrong
// config's routes/DNS/interface (same reasoning as RemoveServerVPNConfig).
func (a *App) SetServerVPNConfig(serverID, engineKind string, values map[string]string) error {
	e, ok := vpnEngines[engineKind]
	if !ok {
		return fmt.Errorf("unknown VPN engine %q", engineKind)
	}
	server, ok := findServer(serverID)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	if current, ok := vpnEngines[server.VPNType]; ok && current.connected(serverID) {
		return fmt.Errorf("disconnect the VPN before replacing its config")
	}
	if err := e.save(serverID, values); err != nil {
		return err
	}
	return setServerVPN(serverID, engineKind, true)
}

// RemoveServerVPNConfig deletes a server's saved VPN config. Refuses while
// the tunnel is connected, so a live tunnel is never left with no config
// on disk to bring it back down cleanly later.
func (a *App) RemoveServerVPNConfig(serverID string) error {
	server, ok := findServer(serverID)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	if e, ok := vpnEngines[server.VPNType]; ok && e.connected(serverID) {
		return fmt.Errorf("disconnect the VPN before removing its config")
	}
	if err := removeVPNFiles(serverID); err != nil {
		return err
	}
	return setServerVPN(serverID, "", false)
}

// removeVPNFiles deletes every file any engine may have written for this
// server — globbed by basename rather than knowing each engine's own
// extensions, so adding a new engine later never requires touching this.
func removeVPNFiles(serverID string) error {
	dir, err := vpnDir()
	if err != nil {
		return err
	}
	matches, err := filepath.Glob(filepath.Join(dir, vpnFileBase(serverID)+".*"))
	if err != nil {
		return err
	}
	for _, m := range matches {
		if rmErr := os.Remove(m); rmErr != nil && !os.IsNotExist(rmErr) {
			return rmErr
		}
	}
	return nil
}

// setServerVPN records which engine (if any) a server's VPN is configured
// with and saves servers.json — mirrors UpdateServer's find-by-ID-and-save
// shape.
func setServerVPN(serverID, engineKind string, enabled bool) error {
	servers := loadServers()
	found := false
	for i, s := range servers {
		if s.ID == serverID {
			servers[i].VPNEnabled = enabled
			servers[i].VPNType = engineKind
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("unknown server")
	}
	return saveServers(servers)
}

// ServerVPNStatus reports whether a config has been saved and whether the
// tunnel is actually up right now, dispatched to whichever engine the
// server is configured with.
func (a *App) ServerVPNStatus(serverID string) (VPNStatus, error) {
	server, ok := findServer(serverID)
	if !ok {
		return VPNStatus{}, fmt.Errorf("unknown server")
	}
	e, ok := vpnEngines[server.VPNType]
	if !ok || !e.configured(serverID) {
		return VPNStatus{}, nil
	}
	return VPNStatus{Configured: true, Connected: e.connected(serverID)}, nil
}

// ConnectServerVPN brings a server's VPN tunnel up via whichever engine
// it's configured with. Every engine's connect() needs admin privileges to
// create a network interface — this app never silently shells out to
// `sudo` (see installSpecs' doc comment in toolActions.go: a headless sudo
// prompt has no way to reach the user and just hangs), so each engine goes
// through `osascript ... with administrator privileges` (runPrivileged
// below), which pops the native macOS password dialog synchronously
// instead — no password is ever cached or stored by Thaloca itself.
func (a *App) ConnectServerVPN(serverID string) error {
	server, ok := findServer(serverID)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	e, ok := vpnEngines[server.VPNType]
	if !ok {
		return fmt.Errorf("no VPN configured for this server")
	}
	if _, err := exec.LookPath(e.binary()); err != nil {
		return fmt.Errorf("%s not found — install it first", e.name())
	}
	if !e.configured(serverID) {
		return fmt.Errorf("no VPN config saved for this server yet")
	}
	return e.connect(serverID)
}

// DisconnectServerVPN tears a server's VPN tunnel down via whichever engine
// it's configured with, the same administrator-privileges path as
// ConnectServerVPN.
func (a *App) DisconnectServerVPN(serverID string) error {
	server, ok := findServer(serverID)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	e, ok := vpnEngines[server.VPNType]
	if !ok {
		return fmt.Errorf("no VPN configured for this server")
	}
	return e.disconnect(serverID)
}

// escapeOsascriptShellArg quotes an argument for safe interpolation inside
// both the shell `do shell script` runs the text through (single-quoting,
// with embedded single quotes escaped) and AppleScript's own outer
// double-quoted string literal (escaping the resulting double quotes).
func escapeOsascriptShellArg(arg string) string {
	shellQuoted := "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
	return strings.ReplaceAll(shellQuoted, `"`, `\"`)
}

// runPrivileged runs one already-assembled shell command line via
// `osascript ... with administrator privileges`, bounded by ctx, returning
// a trimmed error including the command's own output on failure.
func runPrivileged(ctx context.Context, shellCommand, actionLabel string) error {
	script := fmt.Sprintf(`do shell script "%s" with administrator privileges`, shellCommand)
	out, err := exec.CommandContext(ctx, "osascript", "-e", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", actionLabel, combinedOutputTail(out, err))
	}
	return nil
}
