package main

import (
	"context"
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

// dockerPSFormat asks Docker for one line per container, fields separated
// by a unit separator (\x1f) — a byte that can't appear in any of these
// fields, unlike a hand-built JSON string, so a container name/status
// containing a literal quote can't break parsing or get silently dropped.
const dockerPSFormat = "{{.ID}}\x1f{{.Names}}\x1f{{.Image}}\x1f{{.Status}}\x1f{{.State}}\x1f{{.Ports}}"

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
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\x1f")
		if len(fields) != 6 {
			continue
		}
		containers = append(containers, RemoteContainer{
			ID:     fields[0],
			Name:   fields[1],
			Image:  fields[2],
			Status: fields[3],
			State:  fields[4],
			Ports:  fields[5],
		})
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
