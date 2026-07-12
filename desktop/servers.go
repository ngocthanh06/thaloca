package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
// is an optional free-form label ("production"/"staging"/"dev"/"").
func (a *App) AddServer(name, host string, port int, user, keyPath, environment string) (ServerConnection, error) {
	host = strings.TrimSpace(host)
	user = strings.TrimSpace(user)
	keyPath = strings.TrimSpace(keyPath)
	environment = strings.TrimSpace(environment)
	if host == "" || user == "" || keyPath == "" {
		return ServerConnection{}, fmt.Errorf("host, user, and key path are required")
	}
	if !isSafeSSHArg(host) || !isSafeSSHArg(user) {
		return ServerConnection{}, fmt.Errorf("host and user must not start with \"-\"")
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
	}

	servers := append(loadServers(), conn)
	if err := saveServers(servers); err != nil {
		return ServerConnection{}, err
	}
	return conn, nil
}

// RemoveServer deletes a saved connection. This only forgets Thaloca's own
// reference to the key path; it never touches the key file itself.
func (a *App) RemoveServer(id string) error {
	servers := loadServers()
	filtered := make([]ServerConnection, 0, len(servers))
	for _, s := range servers {
		if s.ID != id {
			filtered = append(filtered, s)
		}
	}
	return saveServers(filtered)
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
	return []string{
		"-i", conn.KeyPath,
		"-p", strconv.Itoa(conn.Port),
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=8",
		conn.User + "@" + conn.Host,
	}
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
	Memory          string                  `json:"memory"`
	Disk            string                  `json:"disk"`
	DiskPercent     int                     `json:"disk_percent"` // -1 if unknown
	DockerAvailable bool                    `json:"docker_available"`
	Containers      []RemoteContainerStatus `json:"containers"`
	Raw             string                  `json:"raw"`
	Error           string                  `json:"error,omitempty"`
}

// remoteCheckScript bundles a few read-only checks into one SSH round trip
// (uptime/load, memory, disk, and — if present — Docker container status).
// Anything not available on the remote is skipped rather than failing the
// whole check.
const remoteCheckScript = `echo '--- uptime ---'; uptime; ` +
	`echo '--- memory ---'; free -h 2>/dev/null || vm_stat; ` +
	`echo '--- disk ---'; df -h / 2>/dev/null; ` +
	`echo '--- docker ---'; (docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null || echo 'docker not available')`

// CheckServer runs the read-only diagnostic bundle above over SSH and
// parses it into structured fields on a best-effort basis. Never mutates
// anything on the remote host.
func (a *App) CheckServer(id string) ServerHealth {
	conn, ok := findServer(id)
	if !ok {
		return ServerHealth{Error: "unknown server", DiskPercent: -1}
	}

	args := append(sshBaseArgs(conn), remoteCheckScript)
	out, err := exec.Command("ssh", args...).CombinedOutput()
	raw := string(out)
	if err != nil {
		return ServerHealth{Reachable: false, Raw: raw, Error: err.Error(), DiskPercent: -1}
	}
	return parseServerHealth(raw)
}

func parseServerHealth(raw string) ServerHealth {
	health := ServerHealth{Reachable: true, Raw: raw, DiskPercent: -1}

	sections := splitCheckSections(raw)
	if uptime, ok := sections["uptime"]; ok {
		health.Uptime = strings.TrimSpace(uptime)
	}
	if memory, ok := sections["memory"]; ok {
		health.Memory = parseMemorySection(memory)
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
	markers := []string{"uptime", "memory", "disk", "docker"}
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
// guessing.
func parseMemorySection(section string) string {
	for _, line := range strings.Split(section, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == "Mem:" {
			return fmt.Sprintf("%s used / %s total", fields[2], fields[1])
		}
	}
	return strings.TrimSpace(section)
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
