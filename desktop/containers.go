package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

// processAlive reports whether pid still exists, via the Unix convention of
// sending signal 0 — delivers nothing, just checks the process still
// exists. EPERM counts as alive: it means the kernel found a process at
// that PID but this (unprivileged) process isn't allowed to signal it —
// e.g. a VPN daemon started via runPrivileged, which runs as root. Only
// ESRCH (or any other error, in practice always ESRCH here) means the PID
// is actually gone.
func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}

func (a *App) StopProcess(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid")
	}
	if pid == 1 {
		return fmt.Errorf("refusing to stop pid 1 (system init)")
	}
	if pid == os.Getpid() {
		return fmt.Errorf("refusing to stop Thaloca's own process")
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}

	// Ask nicely first (SIGINT). A successfully *delivered* signal only
	// means the process received it — plenty of GUI/Electron apps ignore
	// SIGINT outright and keep running, which the old code treated as
	// "stopped" since it only escalated to SIGKILL when delivery itself
	// failed. Give it a short grace period to actually exit, then force
	// it either way.
	if err := process.Signal(os.Interrupt); err != nil {
		// Couldn't even deliver SIGINT (already gone, or a permission
		// issue) — go straight to SIGKILL rather than giving up.
		if killErr := process.Kill(); killErr != nil && processAlive(pid) {
			return killErr
		}
	} else {
		deadline := time.Now().Add(3 * time.Second)
		for processAlive(pid) && time.Now().Before(deadline) {
			time.Sleep(150 * time.Millisecond)
		}
		if processAlive(pid) {
			if killErr := process.Kill(); killErr != nil && processAlive(pid) {
				return killErr
			}
		}
	}

	a.addEvent("action", fmt.Sprintf("process %d", pid), "", "process", fmt.Sprintf("%d", pid), "stopped", fmt.Sprintf("Process %d stopped", pid))
	return nil
}

// ContainerLogs returns the most recent log lines of a container.
func (a *App) ContainerLogs(containerID string) string {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, _ := exec.CommandContext(ctx, "docker", "logs", "--tail", "80", containerID).CombinedOutput()
	return truncateLogOutput(output)
}

// ContainerSize returns a container's disk usage as Docker's own
// human-readable string (e.g. "1.2MB (virtual 245MB)"), fetched lazily per
// row from the Runtime view (see runtime.ts's loadContainerSizes) rather
// than folded into the main Snapshot scan — `docker ps -s` has to compute
// each container's writable-layer size on the fly, which would slow down
// every 30s Runtime poll for every container if it ran there instead.
func (a *App) ContainerSize(containerID string) (string, error) {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return "", fmt.Errorf("container id is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "ps", "-a", "-s", "--filter", "id="+containerID, "--format", "{{.Size}}").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

// ProjectLogs returns the combined, interleaved log tail of every container
// in a Docker Compose project ("docker compose logs" prefixes each line
// with its service name, which is exactly the unified view a project-level
// log panel needs — no separate per-container fetch/merge required).
func (a *App) ProjectLogs(project string) string {
	project = strings.TrimSpace(project)
	if project == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, _ := exec.CommandContext(ctx, "docker", "compose", "-p", project, "logs", "--no-color", "--tail", "80").CombinedOutput()
	return truncateLogOutput(output)
}

func truncateLogOutput(output []byte) string {
	text := strings.TrimSpace(string(output))
	if len(text) > 16384 {
		text = text[len(text)-16384:]
	}
	if text == "" {
		return "No log output."
	}
	return text
}

func (a *App) StopContainer(containerID string) error {
	if err := runDockerCommand("stop", containerID, 30*time.Second); err != nil {
		return err
	}
	a.addEvent("action", "container "+discovery.ShortID(containerID), "", "container", containerID, "stopped", "Container "+discovery.ShortID(containerID)+" stopped")
	return nil
}

func (a *App) StartContainer(containerID string) error {
	if err := runDockerCommand("start", containerID, 30*time.Second); err != nil {
		return err
	}
	a.addEvent("action", "container "+discovery.ShortID(containerID), "", "container", containerID, "started", "Container "+discovery.ShortID(containerID)+" started")
	return nil
}

func (a *App) RestartContainer(containerID string) error {
	if err := runDockerCommand("restart", containerID, 60*time.Second); err != nil {
		return err
	}
	a.addEvent("action", "container "+discovery.ShortID(containerID), "", "container", containerID, "restarted", "Container "+discovery.ShortID(containerID)+" restarted")
	return nil
}

// ComposeDown stops and removes every container of a compose project.
func (a *App) ComposeDown(project string) error {
	project = strings.TrimSpace(project)
	if project == "" {
		return fmt.Errorf("project name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", "compose", "-p", project, "down").CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("docker compose down: %s", message)
	}
	a.addEvent("action", project, project, "project", project, "down", "Project "+project+" brought down")
	return nil
}

var containerIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// OpenContainerTerminal used to live here (opening Terminal.app externally
// via openInTerminal below); it's now a PTY-backed session embedded in
// Thaloca itself — see desktop/containerTerminal.go.

func openInTerminal(command string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("opening a terminal is only supported on macOS")
	}
	script := fmt.Sprintf(`tell application "Terminal"
	activate
	do script "%s"
end tell`, strings.ReplaceAll(command, `"`, `\"`))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "osascript", "-e", script).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("could not open Terminal: %s", message)
	}
	return nil
}

func runDockerCommand(action, containerID string, timeout time.Duration) error {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return fmt.Errorf("container id is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", action, containerID).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("docker %s: %s", action, message)
	}
	return nil
}

// GetActivity returns git activity for all repos in common directories
