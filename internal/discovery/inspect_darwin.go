package discovery

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

type DarwinInspector struct {
	runner commandRunner
}

func NewDarwinInspector() *DarwinInspector {
	return &DarwinInspector{runner: execRunner{}}
}

func (i *DarwinInspector) Inspect(ctx context.Context, pid int) (Process, error) {
	output, err := i.runner.Output(ctx, "ps", "-p", strconv.Itoa(pid), "-o", "pid=", "-o", "ppid=", "-o", "user=", "-o", "%cpu=", "-o", "%mem=", "-o", "etime=", "-o", "command=")
	if err != nil {
		return Process{}, fmt.Errorf("read process %d: %w", pid, err)
	}
	process, err := parsePS(string(output))
	if err != nil {
		return Process{}, err
	}
	process.Permission = "readable"

	cwdOutput, cwdErr := i.runner.Output(ctx, "lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn")
	if cwdErr != nil {
		process.Permission = "partial"
		return process, nil
	}
	process.WorkingDirectory = parseCWD(string(cwdOutput))
	return process, nil
}

func parsePS(output string) (Process, error) {
	fields := strings.Fields(strings.TrimSpace(output))
	if len(fields) < 7 {
		return Process{}, fmt.Errorf("unexpected ps output")
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil {
		return Process{}, fmt.Errorf("invalid process PID: %w", err)
	}
	ppid, err := strconv.Atoi(fields[1])
	if err != nil {
		return Process{}, fmt.Errorf("invalid parent PID: %w", err)
	}
	cpu, err := strconv.ParseFloat(strings.ReplaceAll(fields[3], ",", "."), 64)
	if err != nil {
		return Process{}, fmt.Errorf("invalid CPU value: %w", err)
	}
	memory, err := strconv.ParseFloat(strings.ReplaceAll(fields[4], ",", "."), 64)
	if err != nil {
		return Process{}, fmt.Errorf("invalid memory value: %w", err)
	}
	return Process{PID: pid, ParentPID: ppid, User: fields[2], CPUPercent: cpu, MemoryPercent: memory, Elapsed: fields[5], Command: strings.Join(fields[6:], " ")}, nil
}

func parseCWD(output string) string {
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "n") {
			return strings.TrimPrefix(line, "n")
		}
	}
	return ""
}
