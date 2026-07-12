package main

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ProcessLogs makes a best-effort attempt to show recent log output for a
// local process Thaloca discovered but did not launch (unlike Docker
// containers, there is no captured stdout/stderr to read). It finds regular
// files the process currently has open via lsof that look like log files
// and tails them.
func (a *App) ProcessLogs(pid int) string {
	if pid <= 0 {
		return "Invalid process id."
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	paths := openLogFiles(ctx, pid)
	if len(paths) == 0 {
		return "No open log file found for this process. Thaloca only discovers processes, it does not launch them, so it can tail a log file the process has open but not output sent to its original terminal."
	}

	var parts []string
	for _, path := range paths {
		tail := tailFile(path, 4096)
		if tail == "" {
			continue
		}
		parts = append(parts, "==> "+path+" <==\n"+tail)
	}
	if len(parts) == 0 {
		return "No readable log file found for this process."
	}
	return truncateLogOutput([]byte(strings.Join(parts, "\n\n")))
}

// openLogFiles lists regular, absolute-path files the process has open
// (via lsof -Fn) whose name looks like a log file. Limited to 5 files so a
// process with hundreds of open files does not flood the log view.
func openLogFiles(ctx context.Context, pid int) []string {
	output, err := exec.CommandContext(ctx, "lsof", "-a", "-p", strconv.Itoa(pid), "-Fn").Output()
	if err != nil {
		return nil
	}
	var paths []string
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 2 || line[0] != 'n' {
			continue
		}
		path := line[1:]
		if !strings.HasPrefix(path, "/") || !looksLikeLogFile(path) {
			continue
		}
		paths = append(paths, path)
		if len(paths) >= 5 {
			break
		}
	}
	return paths
}

func looksLikeLogFile(path string) bool {
	lower := strings.ToLower(path)
	return strings.HasSuffix(lower, ".log") || strings.Contains(lower, "/log/") || strings.Contains(lower, "/logs/")
}

// tailFile reads the last maxBytes of a file. Best-effort: any read error
// (permissions, file gone) simply yields no output for that file.
func tailFile(path string, maxBytes int64) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	size := info.Size()
	offset := int64(0)
	if size > maxBytes {
		offset = size - maxBytes
	}
	if _, err := file.Seek(offset, 0); err != nil {
		return ""
	}
	data := make([]byte, size-offset)
	if _, err := file.Read(data); err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
