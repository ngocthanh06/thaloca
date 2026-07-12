package cron

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

type Job struct {
	Line     int      `json:"line"`
	Schedule string   `json:"schedule"`
	Command  string   `json:"command"`
	Disabled bool     `json:"disabled"`
	Source   string   `json:"source"`
	Env      []string `json:"env,omitempty"`
}

type Reader struct{}

func NewReader() Reader { return Reader{} }

func (Reader) List(ctx context.Context) ([]Job, error) {
	output, err := exec.CommandContext(ctx, "crontab", "-l").CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(output))
		if strings.Contains(text, "no crontab") {
			return nil, nil
		}
		return nil, fmt.Errorf("read crontab: %w: %s", err, text)
	}
	return Parse(string(output)), nil
}

func Parse(content string) []Job {
	var jobs []Job
	var env []string
	for index, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		disabled := false
		if strings.HasPrefix(line, "#") {
			trimmed := strings.TrimSpace(strings.TrimPrefix(line, "#"))
			fields := strings.Fields(trimmed)
			if len(fields) < 6 || !looksLikeSchedule(fields[:5]) {
				continue
			}
			line = trimmed
			disabled = true
		}
		if strings.Contains(line, "=") && !strings.Contains(line, " ") {
			env = append(env, line)
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 6 || !looksLikeSchedule(fields[:5]) {
			continue
		}
		jobs = append(jobs, Job{
			Line:     index + 1,
			Schedule: strings.Join(fields[:5], " "),
			Command:  strings.Join(fields[5:], " "),
			Disabled: disabled,
			Source:   "user-crontab",
			Env:      append([]string(nil), env...),
		})
	}
	return jobs
}

func looksLikeSchedule(fields []string) bool {
	if len(fields) != 5 {
		return false
	}
	for _, field := range fields {
		if field == "" || strings.Contains(field, "=") {
			return false
		}
	}
	return true
}
