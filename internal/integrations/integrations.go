package integrations

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type Snapshot struct {
	Docker  DockerSnapshot  `json:"docker"`
	PM2     PM2Snapshot     `json:"pm2"`
	Laravel LaravelSnapshot `json:"laravel"`
}

type DockerSnapshot struct {
	Available  bool              `json:"available"`
	Error      string            `json:"error,omitempty"`
	Containers []DockerContainer `json:"containers"`
}

type DockerContainer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
	Status string `json:"status"`
	Ports  string `json:"ports"`
}

type PM2Snapshot struct {
	Available bool         `json:"available"`
	Error     string       `json:"error,omitempty"`
	Processes []PM2Process `json:"processes"`
}

type PM2Process struct {
	Name     string `json:"name"`
	PID      int    `json:"pid"`
	Status   string `json:"status"`
	Restarts int    `json:"restarts"`
	CPU      int    `json:"cpu"`
	Memory   int64  `json:"memory"`
	CWD      string `json:"cwd,omitempty"`
}

type LaravelSnapshot struct {
	Detected bool             `json:"detected"`
	Root     string           `json:"root,omitempty"`
	Jobs     []LaravelJobHint `json:"jobs"`
}

type LaravelJobHint struct {
	Name    string `json:"name"`
	Command string `json:"command"`
	Kind    string `json:"kind"`
}

func Scan(ctx context.Context, root string) Snapshot {
	snapshot := Snapshot{
		Docker:  scanDocker(ctx),
		PM2:     scanPM2(ctx),
		Laravel: scanLaravel(root),
	}
	if snapshot.Docker.Containers == nil {
		snapshot.Docker.Containers = []DockerContainer{}
	}
	if snapshot.PM2.Processes == nil {
		snapshot.PM2.Processes = []PM2Process{}
	}
	if snapshot.Laravel.Jobs == nil {
		snapshot.Laravel.Jobs = []LaravelJobHint{}
	}
	return snapshot
}

func scanDocker(ctx context.Context) DockerSnapshot {
	if _, err := exec.LookPath("docker"); err != nil {
		return DockerSnapshot{Available: false, Error: "docker command not found", Containers: []DockerContainer{}}
	}
	output, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{json .}}").Output()
	if err != nil {
		return DockerSnapshot{Available: true, Error: strings.TrimSpace(err.Error()), Containers: []DockerContainer{}}
	}
	var containers []DockerContainer
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var raw struct {
			ID     string
			Names  string
			Image  string
			Status string
			Ports  string
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		containers = append(containers, DockerContainer{ID: raw.ID, Name: raw.Names, Image: raw.Image, Status: raw.Status, Ports: raw.Ports})
	}
	return DockerSnapshot{Available: true, Containers: containers}
}

func scanPM2(ctx context.Context) PM2Snapshot {
	if _, err := exec.LookPath("pm2"); err != nil {
		return PM2Snapshot{Available: false, Error: "pm2 command not found", Processes: []PM2Process{}}
	}
	output, err := exec.CommandContext(ctx, "pm2", "jlist").Output()
	if err != nil {
		return PM2Snapshot{Available: true, Error: strings.TrimSpace(err.Error()), Processes: []PM2Process{}}
	}
	var raw []struct {
		Name   string `json:"name"`
		PID    int    `json:"pid"`
		PM2Env struct {
			Status    string `json:"status"`
			Restarted int    `json:"restart_time"`
			CWD       string `json:"pm_cwd"`
		} `json:"pm2_env"`
		Monit struct {
			CPU    int   `json:"cpu"`
			Memory int64 `json:"memory"`
		} `json:"monit"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return PM2Snapshot{Available: true, Error: "cannot parse pm2 jlist", Processes: []PM2Process{}}
	}
	processes := make([]PM2Process, 0, len(raw))
	for _, item := range raw {
		processes = append(processes, PM2Process{Name: item.Name, PID: item.PID, Status: item.PM2Env.Status, Restarts: item.PM2Env.Restarted, CPU: item.Monit.CPU, Memory: item.Monit.Memory, CWD: item.PM2Env.CWD})
	}
	return PM2Snapshot{Available: true, Processes: processes}
}

func scanLaravel(root string) LaravelSnapshot {
	if root == "" {
		return LaravelSnapshot{Jobs: []LaravelJobHint{}}
	}
	manifest := filepath.Join(root, "artisan")
	if _, err := os.Stat(manifest); err != nil {
		return LaravelSnapshot{Jobs: []LaravelJobHint{}}
	}
	return LaravelSnapshot{Detected: true, Root: root, Jobs: []LaravelJobHint{
		{Name: "Queue worker", Kind: "queue", Command: "php artisan queue:work"},
		{Name: "Scheduler", Kind: "scheduler", Command: "php artisan schedule:work"},
		{Name: "Failed jobs", Kind: "diagnostic", Command: "php artisan queue:failed"},
	}}
}
