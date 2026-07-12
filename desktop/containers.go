package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

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
	if err := process.Signal(os.Interrupt); err != nil {
		if err := process.Kill(); err != nil {
			return err
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

// OpenContainerTerminal opens Terminal.app with an interactive shell inside
// the container (bash when available, sh otherwise).
func (a *App) OpenContainerTerminal(containerID string) error {
	containerID = strings.TrimSpace(containerID)
	if !containerIDPattern.MatchString(containerID) {
		return fmt.Errorf("invalid container id")
	}
	command := fmt.Sprintf("docker exec -it %s sh -c 'command -v bash >/dev/null && exec bash || exec sh'", containerID)
	return openInTerminal(command)
}

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
