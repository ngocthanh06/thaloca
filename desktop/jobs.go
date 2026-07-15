package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
	"sort"
	"strings"

	"thaloca.local/thaloca/internal/cron"
	"thaloca.local/thaloca/internal/discovery"
)

func discoverJobs(ctx context.Context, dockerServices []discovery.Service) []Job {
	var jobs []Job
	jobs = append(jobs, scanCronJobs(ctx)...)
	jobs = append(jobs, scanLaunchdJobs(ctx)...)
	jobs = append(jobs, scanPM2Jobs(ctx)...)
	jobs = append(jobs, scanDockerJobs(ctx, dockerServices)...)
	sort.Slice(jobs, func(i, j int) bool {
		if jobs[i].Source == jobs[j].Source {
			return jobs[i].Name < jobs[j].Name
		}
		return jobs[i].Source < jobs[j].Source
	})
	return jobs
}

func scanCronJobs(ctx context.Context) []Job {
	entries, err := cron.NewReader().List(ctx)
	if err != nil {
		return nil
	}
	var jobs []Job
	for _, entry := range entries {
		if entry.Disabled {
			continue
		}
		jobs = append(jobs, Job{ID: fmt.Sprintf("cron:%d", entry.Line), Name: jobNameFromCommand(entry.Command), Source: "cron", Status: "scheduled", Schedule: entry.Schedule, Command: entry.Command})
	}
	return jobs
}

func scanLaunchdJobs(ctx context.Context) []Job {
	if runtime.GOOS != "darwin" {
		return nil
	}
	output, err := exec.CommandContext(ctx, "launchctl", "list").Output()
	if err != nil {
		return nil
	}
	var jobs []Job
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] == "PID" {
			continue
		}
		pid := 0
		if fields[0] != "-" {
			fmt.Sscanf(fields[0], "%d", &pid)
		}
		status := "loaded"
		if pid > 0 {
			status = "running"
		}
		label := fields[2]
		if !looksRelevantJob(label) {
			continue
		}
		jobs = append(jobs, Job{ID: "launchd:" + label, Name: label, Source: "launchd", Status: status, Command: label, PID: pid})
	}
	return jobs
}

func scanPM2Jobs(ctx context.Context) []Job {
	if _, err := exec.LookPath("pm2"); err != nil {
		return nil
	}
	output, err := exec.CommandContext(ctx, "pm2", "jlist").Output()
	if err != nil {
		return nil
	}
	var raw []struct {
		Name   string `json:"name"`
		PID    int    `json:"pid"`
		PM2Env struct {
			Status string `json:"status"`
			CWD    string `json:"pm_cwd"`
		} `json:"pm2_env"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil
	}
	var jobs []Job
	for _, item := range raw {
		if !looksRelevantJob(item.Name) {
			continue
		}
		jobs = append(jobs, Job{ID: "pm2:" + item.Name, Name: item.Name, Source: "pm2", Status: item.PM2Env.Status, Command: item.Name, PID: item.PID, Project: item.PM2Env.CWD})
	}
	return jobs
}

// scanDockerJobs reuses Snapshot's already-scanned container list (rather
// than shelling out to `docker ps` again) and layers job-specific concerns
// on top: filtering to running-only candidates that look like background
// workloads, and enriching with the in-container process list via `docker
// top`.
func scanDockerJobs(ctx context.Context, services []discovery.Service) []Job {
	var jobs []Job
	for _, svc := range services {
		if svc.Status == "stopped" {
			continue
		}
		fullCommand := discovery.DockerFullCommand(ctx, svc.ContainerID)
		if fullCommand == "" {
			fullCommand = svc.Command
		}
		haystack := svc.Name + " " + svc.Image + " " + fullCommand + " " + labelsToString(svc.Labels)
		isBackgroundWorkload := len(svc.Ports) == 0
		// The in-container process list both decides worker-likeness for
		// containers behind an exposed port and is shown in the UI so users
		// can see what job actually runs inside.
		topOutput := dockerTopOutput(ctx, svc.ContainerID)
		if !looksRelevantJob(haystack) && !isBackgroundWorkload && !looksLikeDockerWorkload(haystack) && !looksLikeDockerWorkload(topOutput) {
			continue
		}
		// Job status has never distinguished healthy/unhealthy (unlike
		// Runtime's service status) — only running vs stopped/unknown.
		status := svc.Status
		if status == "healthy" || status == "unhealthy" {
			status = "running"
		}
		jobs = append(jobs, Job{ID: "docker-job:" + discovery.ShortID(svc.ContainerID), Name: svc.Name, Source: "docker", Status: status, Command: fullCommand, ContainerID: svc.ContainerID, Project: svc.Project, Processes: parseDockerTopProcesses(topOutput)})
	}
	return jobs
}

func labelsToString(labels map[string]string) string {
	pairs := make([]string, 0, len(labels))
	for k, v := range labels {
		pairs = append(pairs, k+"="+v)
	}
	return strings.Join(pairs, ",")
}

func looksRelevantJob(value string) bool {
	lower := strings.ToLower(value)
	// macOS system services (com.apple.*, e.g. com.apple.mdworker.shared.<id>)
	// are never a developer's background job, but plenty of them contain
	// "worker" and would otherwise match the keyword list below — and since
	// their labels churn (new id) every scan, they'd flood the job list and
	// the Activity timeline with bogus discovered/exited events.
	if strings.HasPrefix(lower, "com.apple.") {
		return false
	}
	keywords := []string{"queue", "worker", "scheduler", "schedule", "cron", "horizon", "celery", "sidekiq", "bull", "resque", "supervisor", "beat"}
	for _, keyword := range keywords {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
}

// looksLikeDockerWorkload matches docker-only workload hints (agents, crawlers,
// bots). Kept separate from looksRelevantJob because launchd labels are full of
// "agent" and would flood the job list.
func looksLikeDockerWorkload(value string) bool {
	lower := strings.ToLower(value)
	keywords := []string{"agent", "crawl", "scrape", "bot", "ingest", "watch"}
	for _, keyword := range keywords {
		if strings.Contains(lower, keyword) {
			return true
		}
	}
	return false
}

func dockerTopOutput(ctx context.Context, containerID string) string {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return ""
	}
	output, err := exec.CommandContext(ctx, "docker", "top", containerID).Output()
	if err != nil {
		return ""
	}
	return string(output)
}

// parseDockerTopProcesses extracts the command column from `docker top`
// output so the UI can show what actually runs inside a container.
func parseDockerTopProcesses(output string) []string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) < 2 {
		return nil
	}
	header := lines[0]
	idx := strings.Index(header, "COMMAND")
	if idx < 0 {
		idx = strings.Index(header, "CMD")
	}
	var processes []string
	for _, line := range lines[1:] {
		command := strings.TrimSpace(line)
		if idx >= 0 && len(line) > idx {
			command = strings.TrimSpace(line[idx:])
		}
		if command != "" {
			processes = append(processes, command)
		}
	}
	if len(processes) > 8 {
		processes = processes[:8]
	}
	return processes
}

func jobNameFromCommand(command string) string {
	trimmed := strings.TrimSpace(command)
	if trimmed == "" {
		return "scheduled job"
	}
	parts := strings.Fields(trimmed)
	if len(parts) >= 3 && parts[0] == "php" && parts[1] == "artisan" {
		return "Laravel " + parts[2]
	}
	if len(parts) > 0 {
		return parts[0]
	}
	return trimmed
}
