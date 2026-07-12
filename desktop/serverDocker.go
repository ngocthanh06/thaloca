package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// RemoteContainer is one container as reported by `docker ps -a` on a
// remote server — the fuller, actionable list behind the Servers tab's
// Containers view (distinct from the lighter-weight status list
// CheckServer's read-only diagnostic bundle already includes).
type RemoteContainer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	Status string `json:"status"`
	State  string `json:"state"` // "running" | "exited" | "restarting" | ... (raw docker State)
	Ports  string `json:"ports"`
}

// runSSHCommand runs one non-interactive command on a server over SSH with
// a bounded timeout, shared by every remote-Docker action below.
func runSSHCommand(conn ServerConnection, timeout time.Duration, remoteCommand string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	args := append(sshBaseArgs(conn), remoteCommand)
	out, err := exec.CommandContext(ctx, "ssh", args...).CombinedOutput()
	return string(out), err
}

// dockerPSFormat asks Docker for one JSON object per line, decodable
// directly with encoding/json.
const dockerPSFormat = `{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}"}`

// ListServerContainers lists every container (running or stopped) on a
// server via `docker ps -a`, parsed into structured rows.
func (a *App) ListServerContainers(id string) ([]RemoteContainer, error) {
	conn, ok := findServer(id)
	if !ok {
		return nil, fmt.Errorf("unknown server")
	}
	out, err := runSSHCommand(conn, 15*time.Second, `docker ps -a --format '`+dockerPSFormat+`'`)
	if err != nil {
		message := strings.TrimSpace(out)
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("%s", message)
	}
	var containers []RemoteContainer
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var c RemoteContainer
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			continue
		}
		containers = append(containers, c)
	}
	return containers, nil
}

// ServerContainerLogs returns the last 200 lines of a remote container's
// logs (stdout and stderr combined, with timestamps).
func (a *App) ServerContainerLogs(id, containerID string) (string, error) {
	conn, ok := findServer(id)
	if !ok {
		return "", fmt.Errorf("unknown server")
	}
	if !containerIDPattern.MatchString(containerID) {
		return "", fmt.Errorf("invalid container id")
	}
	out, err := runSSHCommand(conn, 15*time.Second, "docker logs --tail 200 --timestamps "+containerID)
	if err != nil {
		message := strings.TrimSpace(out)
		if message == "" {
			message = err.Error()
		}
		return out, fmt.Errorf("%s", message)
	}
	return out, nil
}

// StartServerContainer starts a stopped container on a remote server.
func (a *App) StartServerContainer(id, containerID string) error {
	return runServerContainerAction(id, containerID, "start")
}

// StopServerContainer stops a running container on a remote server.
func (a *App) StopServerContainer(id, containerID string) error {
	return runServerContainerAction(id, containerID, "stop")
}

// RestartServerContainer restarts a container on a remote server.
func (a *App) RestartServerContainer(id, containerID string) error {
	return runServerContainerAction(id, containerID, "restart")
}

func runServerContainerAction(id, containerID, action string) error {
	conn, ok := findServer(id)
	if !ok {
		return fmt.Errorf("unknown server")
	}
	if !containerIDPattern.MatchString(containerID) {
		return fmt.Errorf("invalid container id")
	}
	out, err := runSSHCommand(conn, 30*time.Second, "docker "+action+" "+containerID)
	if err != nil {
		message := strings.TrimSpace(out)
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}
