package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"thaloca.local/thaloca/internal/cron"
	"thaloca.local/thaloca/internal/detection"
	"thaloca.local/thaloca/internal/discovery"
	"thaloca.local/thaloca/internal/integrations"
	"thaloca.local/thaloca/internal/security"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	switch os.Args[1] {
	case "discover":
		err = runDiscover(ctx, hasArg("--json"))
	case "inspect":
		err = runInspect(ctx, os.Args[2:])
	case "detect":
		err = runDetect(os.Args[2:])
	case "cron":
		err = runCron(ctx, os.Args[2:])
	case "integrations":
		err = runIntegrations(ctx, os.Args[2:])
	case "scan":
		err = runScanCommand(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runIntegrations(ctx context.Context, args []string) error {
	root := "."
	if len(args) > 0 {
		root = args[0]
	}
	snapshot := integrations.Scan(ctx, root)
	return json.NewEncoder(os.Stdout).Encode(snapshot)
}

func runCron(ctx context.Context, args []string) error {
	if len(args) > 0 && args[0] != "list" {
		return fmt.Errorf("usage: thaloca cron list")
	}
	jobs, err := cron.NewReader().List(ctx)
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "STATE\tSCHEDULE\tCOMMAND")
	for _, job := range jobs {
		state := "enabled"
		if job.Disabled {
			state = "disabled"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\n", state, job.Schedule, job.Command)
	}
	return w.Flush()
}

func runDiscover(ctx context.Context, jsonOutput bool) error {
	listeners, err := discovery.NewDarwinScanner().Scan(ctx)
	if err != nil {
		return fmt.Errorf("discover: %w", err)
	}
	if jsonOutput {
		return json.NewEncoder(os.Stdout).Encode(listeners)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PORT\tPID\tPROCESS\tADDRESS")
	for _, listener := range listeners {
		fmt.Fprintf(w, "%d\t%d\t%s\t%s\n", listener.Port, listener.PID, listener.Process, listener.Address)
	}
	return w.Flush()
}

func runInspect(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: thaloca inspect <pid> [--json]")
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil || pid <= 0 {
		return fmt.Errorf("inspect: invalid PID %q", args[0])
	}
	process, err := discovery.NewDarwinInspector().Inspect(ctx, pid)
	if err != nil {
		return fmt.Errorf("inspect: %w", err)
	}
	if contains(args[1:], "--json") {
		return json.NewEncoder(os.Stdout).Encode(process)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "PID\t%d\nPPID\t%d\nUSER\t%s\nCPU\t%.2f%%\nMEMORY\t%.2f%%\nUPTIME\t%s\nCOMMAND\t%s\nCWD\t%s\n", process.PID, process.ParentPID, process.User, process.CPUPercent, process.MemoryPercent, process.Elapsed, process.Command, valueOrUnknown(process.WorkingDirectory))
	if process.WorkingDirectory != "" {
		result := detection.Detect(process.WorkingDirectory)
		fmt.Fprintf(w, "PROJECT\t%s\nFRAMEWORK\t%s\nCONFIDENCE\t%d%%\n", valueOrUnknown(result.Root), valueOrUnknown(result.Framework), result.Confidence)
	}
	return w.Flush()
}

func runDetect(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: thaloca detect <path> [--json]")
	}
	result := detection.Detect(args[0])
	if contains(args[1:], "--json") {
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "ROOT\t%s\nPROJECT\t%s\nFRAMEWORK\t%s\nCONFIDENCE\t%d%%\n", valueOrUnknown(result.Root), valueOrUnknown(result.Name), valueOrUnknown(result.Framework), result.Confidence)
	for _, evidence := range result.Evidence {
		fmt.Fprintf(w, "EVIDENCE\t%s\n", evidence)
	}
	return w.Flush()
}

// runScanCommand dispatches "scan" (a security scan of a local path) from
// "scan git-hook" (installing/uninstalling the git hooks that run it
// automatically) — kept as one CLI subcommand so main()'s switch doesn't
// need to change again when git-hook support lands.
func runScanCommand(args []string) error {
	if len(args) > 0 && args[0] == "git-hook" {
		return runScanGitHook(args[1:])
	}
	return runScan(args)
}

// runScan scans path (default ".") with every available scanner (secrets,
// vulns, sast — see internal/security) and prints the findings. Unlike the
// other subcommands, this gets its own longer timeout: a real scan
// (gitleaks/trivy/gosec/semgrep) commonly takes well past main()'s default
// 10s budget for the fast local-discovery commands.
func runScan(args []string) error {
	path := "."
	jsonOutput := false
	failOn := security.SeverityHigh
	minSeverity := security.SeverityLow
	for _, arg := range args {
		switch {
		case arg == "--json":
			jsonOutput = true
		case strings.HasPrefix(arg, "--fail-on="):
			failOn = security.Severity(strings.TrimPrefix(arg, "--fail-on="))
		case strings.HasPrefix(arg, "--severity="):
			minSeverity = security.Severity(strings.TrimPrefix(arg, "--severity="))
		case !strings.HasPrefix(arg, "--"):
			path = arg
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	report := security.Scan(ctx, path, nil)

	if jsonOutput {
		if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
			return err
		}
	} else {
		printScanReport(report, minSeverity)
	}

	if failOn != "" && report.HighestSeverity().AtLeast(failOn) {
		return fmt.Errorf("security scan found findings at or above %q severity", failOn)
	}
	return nil
}

func printScanReport(report security.Report, minSeverity security.Severity) {
	fmt.Printf("Security scan: %s\n\n", report.Path)
	for _, s := range report.Statuses {
		if s.Skipped {
			fmt.Printf("  [skip] %s (%s): %s\n", s.Scanner, s.Tool, s.Reason)
		} else {
			fmt.Printf("  [ok]   %s (%s)\n", s.Scanner, s.Tool)
		}
	}
	fmt.Println()

	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "SEVERITY\tSCANNER\tTITLE\tFILE")
	shown := 0
	for _, f := range report.Findings {
		if minSeverity != "" && !f.Severity.AtLeast(minSeverity) {
			continue
		}
		location := f.File
		if f.Line > 0 {
			location = fmt.Sprintf("%s:%d", f.File, f.Line)
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", f.Severity, f.Scanner, f.Title, location)
		shown++
	}
	w.Flush()
	fmt.Printf("\n%d finding(s) shown (%d total)\n", shown, len(report.Findings))
}

// runScanGitHook installs/uninstalls the pre-commit/pre-push hooks that run
// `thaloca scan` automatically (see internal/security/git_hooks.go).
func runScanGitHook(args []string) error {
	repoPath := "."
	install := contains(args, "--install")
	uninstall := contains(args, "--uninstall")
	preCommit := contains(args, "--pre-commit")
	prePush := contains(args, "--pre-push")
	for _, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			repoPath = arg
		}
	}
	if preCommit == prePush {
		return fmt.Errorf("usage: thaloca scan git-hook --pre-commit|--pre-push --install|--uninstall [path]")
	}
	hook := security.HookPreCommit
	if prePush {
		hook = security.HookPrePush
	}
	switch {
	case install:
		return security.InstallGitHook(repoPath, hook)
	case uninstall:
		return security.UninstallGitHook(repoPath, hook)
	default:
		return fmt.Errorf("usage: thaloca scan git-hook --pre-commit|--pre-push --install|--uninstall [path]")
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: thaloca <discover|inspect|detect|cron|integrations|scan> [arguments]")
	os.Exit(2)
}

func hasArg(want string) bool { return contains(os.Args[2:], want) }

func contains(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func valueOrUnknown(value string) string {
	if value == "" {
		return "unknown"
	}
	return value
}
