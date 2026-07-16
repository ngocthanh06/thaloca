package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"thaloca.local/thaloca/internal/cron"
)

// ServerConnection is one saved SSH target. Only the key file's PATH is
// ever stored here — Thaloca never reads or copies the private key's
// contents; the system `ssh` binary reads it directly from disk when
// connecting, the same as if you ran it by hand.
type ServerConnection struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	KeyPath string `json:"key_path"`
	// Environment is a free-form display label ("production", "staging",
	// "dev", or "" for none) — purely cosmetic, never affects behavior.
	Environment string `json:"environment,omitempty"`
	// ProxyJump is an optional "user@host[:port]" bastion to hop through
	// (ssh -J), for servers only reachable via a jump host. Empty means
	// connect directly.
	ProxyJump string `json:"proxy_jump,omitempty"`
	// VPNEnabled is true once a VPN config has been saved for this server,
	// and VPNType names which engine (see serverVPN.go's vpnEngines
	// registry, e.g. "wireguard"/"openvpn"). The config itself — it
	// commonly holds a private key or password — is never stored here; it
	// lives in its own file(s) under ~/.thaloca/vpn/, the same "path/flag
	// only, never the secret" pattern KeyPath already uses for SSH keys.
	VPNEnabled bool   `json:"vpn_enabled,omitempty"`
	VPNType    string `json:"vpn_type,omitempty"`
}

type serverStore struct {
	Servers []ServerConnection `json:"servers"`
}

func serversPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "servers.json"), nil
}

func loadServers() []ServerConnection {
	path, err := serversPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var store serverStore
	if err := json.Unmarshal(data, &store); err != nil {
		return nil
	}
	return store.Servers
}

func saveServers(servers []ServerConnection) error {
	path, err := serversPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(serverStore{Servers: servers}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// ListServers returns every configured server connection.
func (a *App) ListServers() []ServerConnection {
	servers := loadServers()
	if servers == nil {
		return []ServerConnection{}
	}
	return servers
}

// AddServer validates and saves a new server connection. keyPath must
// already exist on disk (it is never read here, only stat'd). environment
// is an optional free-form label ("production"/"staging"/"dev"/""). proxyJump
// is an optional "user@host[:port]" bastion to hop through, or "".
func (a *App) AddServer(name, host string, port int, user, keyPath, environment, proxyJump string) (ServerConnection, error) {
	host = strings.TrimSpace(host)
	user = strings.TrimSpace(user)
	keyPath = strings.TrimSpace(keyPath)
	environment = strings.TrimSpace(environment)
	proxyJump = strings.TrimSpace(proxyJump)
	if host == "" || user == "" || keyPath == "" {
		return ServerConnection{}, fmt.Errorf("host, user, and key path are required")
	}
	if !isSafeSSHArg(host) || !isSafeSSHArg(user) {
		return ServerConnection{}, fmt.Errorf("host and user must not start with \"-\"")
	}
	if proxyJump != "" && !isSafeSSHArg(proxyJump) {
		return ServerConnection{}, fmt.Errorf("proxy jump must not start with \"-\"")
	}
	if _, err := os.Stat(keyPath); err != nil {
		return ServerConnection{}, fmt.Errorf("key file not found: %s", keyPath)
	}
	if port <= 0 {
		port = 22
	}
	if name == "" {
		name = host
	}

	conn := ServerConnection{
		ID:          fmt.Sprintf("srv-%d", time.Now().UnixNano()),
		Name:        name,
		Host:        host,
		Port:        port,
		User:        user,
		KeyPath:     keyPath,
		Environment: environment,
		ProxyJump:   proxyJump,
	}

	servers := append(loadServers(), conn)
	if err := saveServers(servers); err != nil {
		return ServerConnection{}, err
	}
	return conn, nil
}

// UpdateServer edits an existing saved connection in place, keeping its ID.
// Validation mirrors AddServer's.
func (a *App) UpdateServer(id, name, host string, port int, user, keyPath, environment, proxyJump string) (ServerConnection, error) {
	host = strings.TrimSpace(host)
	user = strings.TrimSpace(user)
	keyPath = strings.TrimSpace(keyPath)
	environment = strings.TrimSpace(environment)
	proxyJump = strings.TrimSpace(proxyJump)
	if host == "" || user == "" || keyPath == "" {
		return ServerConnection{}, fmt.Errorf("host, user, and key path are required")
	}
	if !isSafeSSHArg(host) || !isSafeSSHArg(user) {
		return ServerConnection{}, fmt.Errorf("host and user must not start with \"-\"")
	}
	if proxyJump != "" && !isSafeSSHArg(proxyJump) {
		return ServerConnection{}, fmt.Errorf("proxy jump must not start with \"-\"")
	}
	if _, err := os.Stat(keyPath); err != nil {
		return ServerConnection{}, fmt.Errorf("key file not found: %s", keyPath)
	}
	if port <= 0 {
		port = 22
	}
	if name == "" {
		name = host
	}

	servers := loadServers()
	updated := ServerConnection{}
	found := false
	for i, s := range servers {
		if s.ID == id {
			servers[i] = ServerConnection{
				ID:          id,
				Name:        name,
				Host:        host,
				Port:        port,
				User:        user,
				KeyPath:     keyPath,
				Environment: environment,
				ProxyJump:   proxyJump,
				VPNEnabled:  s.VPNEnabled,
				VPNType:     s.VPNType,
			}
			updated = servers[i]
			found = true
			break
		}
	}
	if !found {
		return ServerConnection{}, fmt.Errorf("unknown server")
	}
	if err := saveServers(servers); err != nil {
		return ServerConnection{}, err
	}
	return updated, nil
}

// RemoveServer deletes a saved connection. This only forgets Thaloca's own
// reference to the key path; it never touches the key file itself. Its VPN
// config (see serverVPN.go), if any, is file(s) Thaloca itself created —
// unlike the SSH key, those are cleaned up here so a removed server
// doesn't leave an orphaned private key/password behind. Refuses while its
// VPN is still connected — same check RemoveServerVPNConfig already makes
// — since deleting the config out from under a live tunnel would leave the
// WireGuard interface or root openvpn process running with nothing left
// that could ever disconnect it again.
func (a *App) RemoveServer(id string) error {
	servers := loadServers()
	filtered := make([]ServerConnection, 0, len(servers))
	for _, s := range servers {
		if s.ID != id {
			filtered = append(filtered, s)
			continue
		}
		if e, ok := vpnEngines[s.VPNType]; ok && e.connected(id) {
			return fmt.Errorf("disconnect the VPN before removing this server")
		}
	}
	// A failed VPN cleanup must fail the whole removal: silently dropping the
	// server record while its private key/password files stayed on disk would
	// leave secrets behind with no way left in the UI to clean them up.
	if err := removeVPNFiles(id); err != nil {
		return fmt.Errorf("could not remove this server's VPN config files: %w", err)
	}
	return saveServers(filtered)
}

// SSHConfigHost is one non-wildcard `Host` entry read from ~/.ssh/config —
// used only to prefill the Add Server form, never saved or connected to
// directly. KeyPath comes from IdentityFile with `~` expanded.
type SSHConfigHost struct {
	Alias     string `json:"alias"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	KeyPath   string `json:"key_path"`
	ProxyJump string `json:"proxy_jump,omitempty"`
}

// ListSSHConfigHosts parses ~/.ssh/config (if present) into one entry per
// non-wildcard Host alias, so a user who already manages hosts there can
// pick one to prefill Add Server instead of retyping host/user/key path by
// hand. Read-only: nothing here is ever written back to ssh config, and
// picking an entry doesn't save a server on its own — the user still
// reviews and submits the Add Server form themselves. Best-effort parser:
// covers the common Host/HostName/User/Port/IdentityFile/ProxyJump
// keywords, not the full ssh_config(5) grammar (no Match/Include support).
func (a *App) ListSSHConfigHosts() ([]SSHConfigHost, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var hosts []SSHConfigHost
	var aliases []string
	var hostName, user, identityFile, proxyJump string
	var port int

	flush := func() {
		for _, alias := range aliases {
			if strings.ContainsAny(alias, "*?") {
				continue
			}
			host := hostName
			if host == "" {
				host = alias
			}
			keyPath := identityFile
			if strings.HasPrefix(keyPath, "~") {
				keyPath = filepath.Join(home, strings.TrimPrefix(keyPath, "~"))
			}
			hosts = append(hosts, SSHConfigHost{
				Alias: alias, Host: host, Port: port, User: user, KeyPath: keyPath, ProxyJump: proxyJump,
			})
		}
		aliases, hostName, user, identityFile, proxyJump, port = nil, "", "", "", "", 0
	}

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		key := strings.ToLower(fields[0])
		value := strings.Join(fields[1:], " ")
		if key == "host" {
			flush()
			aliases = fields[1:]
			continue
		}
		switch key {
		case "hostname":
			hostName = value
		case "user":
			user = value
		case "identityfile":
			identityFile = value
		case "proxyjump":
			proxyJump = value
		case "port":
			if p, err := strconv.Atoi(value); err == nil {
				port = p
			}
		}
	}
	flush()
	return hosts, nil
}

func findServer(id string) (ServerConnection, bool) {
	for _, s := range loadServers() {
		if s.ID == id {
			return s, true
		}
	}
	return ServerConnection{}, false
}

// sshBaseArgs are the non-interactive safety flags used for every SSH
// invocation: BatchMode disables any password/interactive prompt (fail
// fast instead of hanging with no TTY to answer it), accept-new auto-trusts
// a host's key the first time (same reason — a first-connection prompt
// would otherwise hang forever) without silently accepting a host key that
// later CHANGES (ssh still fails that case, correctly flagging a possible
// MITM), and ConnectTimeout bounds how long an unreachable host can stall.
// isSafeSSHArg rejects a hostname/username that could be misread as an SSH
// command-line option — ssh's argument parser reads a leading "-" as the
// start of an option (e.g. "-oProxyCommand=...") rather than as part of the
// target, a classic argument-injection vector. A genuine hostname or
// username never starts with a dash.
func isSafeSSHArg(s string) bool {
	return s != "" && !strings.HasPrefix(s, "-")
}

func sshBaseArgs(conn ServerConnection) []string {
	args := []string{
		"-i", conn.KeyPath,
		"-p", strconv.Itoa(conn.Port),
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=8",
	}
	if conn.ProxyJump != "" {
		args = append(args, "-J", conn.ProxyJump)
	}
	return append(args, conn.User+"@"+conn.Host)
}

// KeyPermissionWarning reports a human-readable warning when a server's
// private key file is readable/writable by anyone other than its owner —
// SSH itself sometimes refuses to use a key like that. Returns "" when the
// key looks fine or can't be stat'd. Never modifies the file — that's
// FixServerKeyPermissions, which requires explicit confirmation first.
func (a *App) KeyPermissionWarning(id string) string {
	conn, ok := findServer(id)
	if !ok {
		return ""
	}
	return keyPermissionWarning(conn.KeyPath)
}

func keyPermissionWarning(keyPath string) string {
	info, err := os.Stat(keyPath)
	if err != nil {
		return ""
	}
	mode := info.Mode().Perm()
	if mode&0o077 == 0 {
		return ""
	}
	return fmt.Sprintf("Key file is readable by group/other (mode %04o) — some SSH servers refuse keys like this. Consider fixing to 0600 (owner-only).", mode)
}

// FixServerKeyPermissions chmods a server's private key file to 0600
// (owner read/write only). Only ever touches the permission bits, never
// reads or changes the file's contents.
func (a *App) FixServerKeyPermissions(id string) error {
	conn, ok := findServer(id)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	return os.Chmod(conn.KeyPath, 0o600)
}

// RemoteContainerStatus is one line of `docker ps` on a remote server, as
// seen by Check's single read-only round trip. The Containers tab
// (serverDocker.go) fetches the fuller, actionable list separately.
type RemoteContainerStatus struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// ServerHealth is CheckServer's parsed, best-effort structured result. Raw
// keeps the full script output for anything the parser didn't recognize
// (an unusual distro's `uptime`/`free`/`df` format) — the UI can always
// fall back to showing Raw when a specific field is empty.
type ServerHealth struct {
	Reachable       bool                    `json:"reachable"`
	Uptime          string                  `json:"uptime"`
	CPUPercent      int                     `json:"cpu_percent"` // -1 if unknown
	Memory          string                  `json:"memory"`
	MemPercent      int                     `json:"mem_percent"` // -1 if unknown
	Disk            string                  `json:"disk"`
	DiskPercent     int                     `json:"disk_percent"` // -1 if unknown
	DockerAvailable bool                    `json:"docker_available"`
	Containers      []RemoteContainerStatus `json:"containers"`
	Raw             string                  `json:"raw"`
	Error           string                  `json:"error,omitempty"`
}

// remoteCheckScript bundles a few read-only checks into one SSH round trip
// (uptime/load, CPU, memory, disk, and — if present — Docker container
// status). Anything not available on the remote is skipped rather than
// failing the whole check. The cpu line tries Linux's `top -bn1` format
// first, falling back to macOS's `top -l 1`.
const remoteCheckScript = `echo '--- uptime ---'; uptime; ` +
	`echo '--- cpu ---'; (top -bn1 2>/dev/null | grep -i '%Cpu(s)' || top -l 1 2>/dev/null | grep -i 'CPU usage'); ` +
	`echo '--- memory ---'; free -h 2>/dev/null || vm_stat; ` +
	`echo '--- disk ---'; df -h / 2>/dev/null; ` +
	`echo '--- docker ---'; (docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null || echo 'docker not available')`

// ListServerCron reads the remote user's crontab over SSH (`crontab -l` is
// read-only — never modifies anything) and parses it with the exact same
// logic the local Jobs tab uses (see internal/cron), so schedule/command/
// enabled-disabled parsing stays identical between local and remote.
func (a *App) ListServerCron(id string) ([]cron.Job, error) {
	conn, ok := findServer(id)
	if !ok {
		return nil, fmt.Errorf("unknown server")
	}
	raw, err := readServerCrontab(conn)
	if err != nil {
		return nil, err
	}
	return cron.Parse(raw), nil
}

// readServerCrontab fetches the remote user's raw crontab text (`crontab -l`
// is read-only). An empty string, nil-error result means "no crontab yet"
// rather than an actual empty file.
func readServerCrontab(conn ServerConnection) (string, error) {
	out, stderr, err := runSSHCommandStdout(conn, 15*time.Second, "crontab -l")
	if err != nil {
		if strings.Contains(stderr, "no crontab") {
			return "", nil
		}
		message := strings.TrimSpace(stderr)
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("read crontab: %w: %s", err, message)
	}
	return out, nil
}

// writeServerCrontab replaces the remote user's entire crontab with content.
// content is base64-encoded before being embedded in the SSH command string
// so arbitrary cron command text (quotes, `$`, backticks, newlines, …)
// can never be misinterpreted by the remote shell — base64's own alphabet
// contains no shell metacharacters.
func writeServerCrontab(conn ServerConnection, content string) error {
	encoded := base64.StdEncoding.EncodeToString([]byte(content))
	_, err := runSSHCommand(conn, 15*time.Second, "echo "+encoded+" | base64 -d | crontab -")
	return err
}

// SetServerCronEnabled enables or disables one line of a server's crontab
// (identified by a cron.Job's Line field, from ListServerCron) by adding or
// removing a leading "#" comment marker, then writes the crontab back. The
// edit is made on the raw crontab text by line number rather than
// rebuilding it from parsed Jobs, so blank lines, env-var lines, and any
// other comments are preserved exactly as-is.
func (a *App) SetServerCronEnabled(id string, line int, enabled bool) error {
	conn, ok := findServer(id)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	raw, err := readServerCrontab(conn)
	if err != nil {
		return err
	}
	updated, err := setCronLineEnabled(raw, line, enabled)
	if err != nil {
		return err
	}
	return writeServerCrontab(conn, updated)
}

// RemoveServerCronLine deletes one line of a server's crontab (identified by
// a cron.Job's Line field, from ListServerCron), then writes the crontab
// back.
func (a *App) RemoveServerCronLine(id string, line int) error {
	conn, ok := findServer(id)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	raw, err := readServerCrontab(conn)
	if err != nil {
		return err
	}
	updated, err := removeCronLine(raw, line)
	if err != nil {
		return err
	}
	return writeServerCrontab(conn, updated)
}

func cronLineIndex(raw string, line int) ([]string, int, error) {
	lines := strings.Split(raw, "\n")
	if line < 1 || line > len(lines) {
		return nil, 0, fmt.Errorf("line %d is out of range", line)
	}
	return lines, line - 1, nil
}

func setCronLineEnabled(raw string, line int, enabled bool) (string, error) {
	lines, idx, err := cronLineIndex(raw, line)
	if err != nil {
		return "", err
	}
	trimmed := strings.TrimSpace(lines[idx])
	isDisabled := strings.HasPrefix(trimmed, "#")
	switch {
	case enabled && isDisabled:
		lines[idx] = strings.TrimSpace(strings.TrimPrefix(trimmed, "#"))
	case !enabled && !isDisabled:
		lines[idx] = "# " + trimmed
	}
	return strings.Join(lines, "\n"), nil
}

func removeCronLine(raw string, line int) (string, error) {
	lines, idx, err := cronLineIndex(raw, line)
	if err != nil {
		return "", err
	}
	lines = append(lines[:idx], lines[idx+1:]...)
	return strings.Join(lines, "\n"), nil
}

// CheckServer runs the read-only diagnostic bundle above over SSH and
// parses it into structured fields on a best-effort basis. Never mutates
// anything on the remote host.
func (a *App) CheckServer(id string) ServerHealth {
	conn, ok := findServer(id)
	if !ok {
		return ServerHealth{Error: "unknown server", CPUPercent: -1, MemPercent: -1, DiskPercent: -1}
	}
	return checkServerHealth(conn)
}

// CheckServerDraft runs the same read-only diagnostic as CheckServer, but
// against connection details straight from the Add/Edit Server form before
// they've been saved — lets that form verify reachability first. Validation
// mirrors AddServer's.
func (a *App) CheckServerDraft(host string, port int, user, keyPath, proxyJump string) ServerHealth {
	host = strings.TrimSpace(host)
	user = strings.TrimSpace(user)
	keyPath = strings.TrimSpace(keyPath)
	proxyJump = strings.TrimSpace(proxyJump)
	if host == "" || user == "" || keyPath == "" {
		return ServerHealth{Error: "host, user, and key path are required", CPUPercent: -1, MemPercent: -1, DiskPercent: -1}
	}
	if !isSafeSSHArg(host) || !isSafeSSHArg(user) {
		return ServerHealth{Error: "host and user must not start with \"-\"", CPUPercent: -1, MemPercent: -1, DiskPercent: -1}
	}
	if proxyJump != "" && !isSafeSSHArg(proxyJump) {
		return ServerHealth{Error: "proxy jump must not start with \"-\"", CPUPercent: -1, MemPercent: -1, DiskPercent: -1}
	}
	if _, err := os.Stat(keyPath); err != nil {
		return ServerHealth{Error: fmt.Sprintf("key file not found: %s", keyPath), CPUPercent: -1, MemPercent: -1, DiskPercent: -1}
	}
	if port <= 0 {
		port = 22
	}
	return checkServerHealth(ServerConnection{Host: host, Port: port, User: user, KeyPath: keyPath, ProxyJump: proxyJump})
}

func checkServerHealth(conn ServerConnection) ServerHealth {
	out, err := runSSHCommand(conn, 15*time.Second, remoteCheckScript)
	raw := out
	if err != nil {
		return ServerHealth{Reachable: false, Raw: raw, Error: err.Error(), CPUPercent: -1, MemPercent: -1, DiskPercent: -1}
	}
	return parseServerHealth(raw)
}

func parseServerHealth(raw string) ServerHealth {
	health := ServerHealth{Reachable: true, Raw: raw, CPUPercent: -1, MemPercent: -1, DiskPercent: -1}

	sections := splitCheckSections(raw)
	if uptime, ok := sections["uptime"]; ok {
		health.Uptime = strings.TrimSpace(uptime)
	}
	if cpu, ok := sections["cpu"]; ok {
		health.CPUPercent = parseCPUSection(cpu)
	}
	if memory, ok := sections["memory"]; ok {
		health.Memory, health.MemPercent = parseMemorySection(memory)
	}
	if disk, ok := sections["disk"]; ok {
		health.Disk, health.DiskPercent = parseDiskSection(disk)
	}
	if docker, ok := sections["docker"]; ok {
		docker = strings.TrimSpace(docker)
		if docker == "" || docker == "docker not available" {
			health.DockerAvailable = false
		} else {
			health.DockerAvailable = true
			health.Containers = parseDockerStatusLines(docker)
		}
	}
	return health
}

// splitCheckSections splits remoteCheckScript's output on its own
// "--- name ---" markers into one string per section.
func splitCheckSections(raw string) map[string]string {
	sections := map[string]string{}
	markers := []string{"uptime", "cpu", "memory", "disk", "docker"}
	for i, name := range markers {
		marker := "--- " + name + " ---"
		idx := strings.Index(raw, marker)
		if idx < 0 {
			continue
		}
		start := idx + len(marker)
		end := len(raw)
		for _, next := range markers[i+1:] {
			if j := strings.Index(raw[start:], "--- "+next+" ---"); j >= 0 {
				end = start + j
				break
			}
		}
		sections[name] = raw[start:end]
	}
	return sections
}

// parseMemorySection expects `free -h`'s "Mem:  total  used  ..." line
// (Linux). On anything else (e.g. macOS `vm_stat`, which has a completely
// different format) it falls back to the raw trimmed section rather than
// guessing, and the percent is left at -1.
func parseMemorySection(section string) (string, int) {
	for _, line := range strings.Split(section, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == "Mem:" {
			text := fmt.Sprintf("%s used / %s total", fields[2], fields[1])
			total, okTotal := parseHumanBytes(fields[1])
			used, okUsed := parseHumanBytes(fields[2])
			if okTotal && okUsed && total > 0 {
				return text, int(used / total * 100)
			}
			return text, -1
		}
	}
	return strings.TrimSpace(section), -1
}

// parseHumanBytes parses `free -h`-style sizes ("31Gi", "6.2Gi", "133Mi",
// "512", …) into bytes so total/used can be compared even though they may
// use different units.
var humanByteRe = regexp.MustCompile(`(?i)^([0-9.]+)\s*([kmgt]?)i?b?$`)

func parseHumanBytes(s string) (float64, bool) {
	m := humanByteRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	value, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	switch strings.ToUpper(m[2]) {
	case "K":
		value *= 1024
	case "M":
		value *= 1024 * 1024
	case "G":
		value *= 1024 * 1024 * 1024
	case "T":
		value *= 1024 * 1024 * 1024 * 1024
	}
	return value, true
}

// parseCPUSection expects one line from either Linux's `top -bn1` ("%Cpu(s):
// 3.2 us, 1.0 sy, ..., 95.0 id, ...") or macOS's `top -l 1` ("CPU usage:
// 5.26% user, 10.52% sys, 84.21% idle"); usage is derived from the idle
// figure since that's the one field both formats share the meaning of.
func parseCPUSection(section string) int {
	line := strings.TrimSpace(section)
	if line == "" {
		return -1
	}
	lower := strings.ToLower(line)
	label := ""
	switch {
	case strings.Contains(lower, "%cpu(s)"):
		label = "id"
	case strings.Contains(lower, "cpu usage"):
		label = "idle"
	default:
		return -1
	}
	idle, ok := extractPercentBefore(line, label)
	if !ok {
		return -1
	}
	return int(100 - idle)
}

func extractPercentBefore(line, label string) (float64, bool) {
	re := regexp.MustCompile(`([0-9]+\.?[0-9]*)\s*%?\s*` + regexp.QuoteMeta(label) + `\b`)
	m := re.FindStringSubmatch(line)
	if m == nil {
		return 0, false
	}
	value, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// parseDiskSection expects `df -h /`'s two-line header+data output; the
// data line's columns are Filesystem, Size, Used, Avail, Use%, Mounted.
func parseDiskSection(section string) (string, int) {
	lines := strings.Split(strings.TrimSpace(section), "\n")
	if len(lines) < 2 {
		return strings.TrimSpace(section), -1
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 5 {
		return strings.TrimSpace(section), -1
	}
	percent := -1
	fmt.Sscanf(strings.TrimSuffix(fields[4], "%"), "%d", &percent)
	return fmt.Sprintf("%s used / %s total (%s)", fields[2], fields[1], fields[4]), percent
}

func parseDockerStatusLines(section string) []RemoteContainerStatus {
	var containers []RemoteContainerStatus
	for _, line := range strings.Split(strings.TrimSpace(section), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		containers = append(containers, RemoteContainerStatus{Name: parts[0], Status: parts[1]})
	}
	return containers
}

// RunServerCommand runs an arbitrary command on a saved server over SSH and
// returns a job ID immediately; poll ToolActionStatus(jobID) (the same
// binding RunToolAction's install/update jobs use) for live output. Kept
// for one-shot scripted commands — the Servers tab itself now uses the
// interactive PTY terminal (see serverTerminal.go) instead.
func (a *App) RunServerCommand(id, command string) (string, error) {
	conn, ok := findServer(id)
	if !ok {
		return "", fmt.Errorf("unknown server")
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return "", fmt.Errorf("command is empty")
	}

	args := append(sshBaseArgs(conn), command)
	jobID := a.startJob("ssh-"+conn.ID, "ssh", args, nil)
	return jobID, nil
}

// RemoteFile is one directory entry as reported by ListServerFiles.
type RemoteFile struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mod_time"` // unix seconds
}

// remoteListScriptTemplate lists one directory's immediate entries (name,
// size, mtime, type), tab-separating the name from a "|"-joined info tuple.
// Tries GNU coreutils' `stat -c` first, falling back to macOS/BSD's
// `stat -f` (mirroring remoteCheckScript's CPU-section GNU/BSD fallback),
// since the two accept incompatible format strings. `%s` is filled in by
// fmt.Sprintf with the (already shell-quoted) target directory.
const remoteListScriptTemplate = `cd %s 2>&1 && for f in * .[!.]* ..?*; do
  [ -e "$f" ] || continue
  info=$(stat -c '%%s|%%Y|%%F' "$f" 2>/dev/null) || info=$(stat -f '%%z|%%Sm|%%HT' -t '%%s' "$f" 2>/dev/null)
  printf '%%s\t%%s\n' "$f" "$info"
done`

// ListServerFiles lists one directory's immediate entries on a server over
// SSH, for the Servers tab's file-transfer browser. remotePath defaults to
// "." (the login shell's starting directory, usually $HOME) when empty.
// Read-only — upload/download (see desktop/serverFileTransfer.go) are the
// only operations that touch the remote filesystem.
func (a *App) ListServerFiles(id, remotePath string) ([]RemoteFile, error) {
	conn, ok := findServer(id)
	if !ok {
		return nil, fmt.Errorf("unknown server")
	}
	if remotePath == "" {
		remotePath = "."
	}
	script := fmt.Sprintf(remoteListScriptTemplate, shellQuote(remotePath))
	out, err := runSSHCommand(conn, 15*time.Second, script)
	if err != nil {
		message := strings.TrimSpace(out)
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("%s", message)
	}

	var files []RemoteFile
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		fields := strings.Split(parts[1], "|")
		if len(fields) != 3 {
			continue
		}
		size, _ := strconv.ParseInt(fields[0], 10, 64)
		modTime, _ := strconv.ParseInt(fields[1], 10, 64)
		files = append(files, RemoteFile{
			Name:    parts[0],
			IsDir:   strings.Contains(strings.ToLower(fields[2]), "directory"),
			Size:    size,
			ModTime: modTime,
		})
	}
	return files, nil
}
