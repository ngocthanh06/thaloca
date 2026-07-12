package discovery

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

type commandRunner interface {
	Output(context.Context, string, ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// DarwinScanner discovers TCP listeners using lsof's machine-readable output.
type DarwinScanner struct {
	runner commandRunner
}

func NewDarwinScanner() *DarwinScanner {
	return &DarwinScanner{runner: execRunner{}}
}

func (s *DarwinScanner) Scan(ctx context.Context) ([]Listener, error) {
	output, err := s.runner.Output(ctx, "lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn")
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return nil, fmt.Errorf("run lsof: %s", strings.TrimSpace(string(exitErr.Stderr)))
		}
		return nil, fmt.Errorf("run lsof: %w", err)
	}

	listeners, err := parseLSOF(strings.NewReader(string(output)))
	if err != nil {
		return nil, fmt.Errorf("parse lsof output: %w", err)
	}

	sort.Slice(listeners, func(i, j int) bool {
		if listeners[i].Port == listeners[j].Port {
			return listeners[i].PID < listeners[j].PID
		}
		return listeners[i].Port < listeners[j].Port
	})
	return listeners, nil
}

func parseLSOF(r io.Reader) ([]Listener, error) {
	scanner := bufio.NewScanner(r)
	var listeners []Listener
	seen := make(map[string]struct{})
	var pid int
	var process string

	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 2 {
			continue
		}

		switch line[0] {
		case 'p':
			parsed, err := strconv.Atoi(line[1:])
			if err != nil {
				return nil, fmt.Errorf("invalid pid %q", line[1:])
			}
			pid = parsed
			process = ""
		case 'c':
			process = line[1:]
		case 'n':
			address, port, ok := splitAddress(line[1:])
			if !ok || pid == 0 {
				continue
			}
			key := fmt.Sprintf("%d|%s|%d", pid, address, port)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			listeners = append(listeners, Listener{
				PID: pid, Process: process, Address: address, Port: port, Network: "tcp",
			})
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return listeners, nil
}

func splitAddress(value string) (string, int, bool) {
	index := strings.LastIndexByte(value, ':')
	if index < 0 || index == len(value)-1 {
		return "", 0, false
	}
	port, err := strconv.Atoi(value[index+1:])
	if err != nil {
		return "", 0, false
	}
	return value[:index], port, true
}
