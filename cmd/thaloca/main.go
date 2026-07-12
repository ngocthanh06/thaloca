package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"text/tabwriter"
	"time"

	"thaloca.local/thaloca/internal/cron"
	"thaloca.local/thaloca/internal/detection"
	"thaloca.local/thaloca/internal/discovery"
	"thaloca.local/thaloca/internal/integrations"
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

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: thaloca <discover|inspect|detect|cron|integrations> [arguments]")
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
