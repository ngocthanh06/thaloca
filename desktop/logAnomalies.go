package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// severeLogPatterns are log lines that indicate a real problem on their
// own — a single occurrence is enough to alert.
var severeLogPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bpanic:`),
	regexp.MustCompile(`(?i)\bfatal error\b`),
	regexp.MustCompile(`(?i)\bout of memory\b`),
	regexp.MustCompile(`(?i)\boom[- ]?killed?\b`),
	regexp.MustCompile(`(?i)\bsegmentation fault\b`),
	regexp.MustCompile(`(?i)\bunhandled exception\b`),
}

// repeatLogPatterns are generic enough (e.g. "error") that one occurrence
// is normal noise — only repeating several times in one scan window is a
// real signal.
var repeatLogPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\btimeout\b`),
	regexp.MustCompile(`(?i)\berror\b`),
	regexp.MustCompile(`(?i)\bconnection refused\b`),
	regexp.MustCompile(`(?i)\bexception\b`),
}

const (
	logScanInterval    = 30 * time.Second
	logRepeatThreshold = 3
)

// logAnomalyState tracks one docker container's log-scanning throttle and
// which error signatures have already been surfaced, so the same
// long-lived panic in `docker logs --tail` doesn't re-alert on every scan.
type logAnomalyState struct {
	lastScanned time.Time
	alerted     map[string]bool
}

// detectLogAnomalies scans running docker containers' recent logs for
// panics/OOM/fatal errors (always) and repeated generic error/timeout lines
// (only above logRepeatThreshold), turning new findings into Anomaly
// entries for the same Overview anomaly strip detectAnomalies feeds.
// Throttled to at most one `docker logs` fetch per container per
// logScanInterval, since Snapshot() (which calls this) can be polled far
// more often than that.
func (a *App) detectLogAnomalies(ctx context.Context, services []Service) []Anomaly {
	a.logAnomalyMu.Lock()
	if a.logAnomalyState == nil {
		a.logAnomalyState = map[string]*logAnomalyState{}
	}
	now := time.Now()
	seen := make(map[string]bool, len(services))
	var toScan []Service
	for _, svc := range services {
		if svc.Source != "docker" || svc.ContainerID == "" || svc.Status == "stopped" {
			continue
		}
		seen[svc.ID] = true
		state, ok := a.logAnomalyState[svc.ID]
		if !ok {
			state = &logAnomalyState{alerted: map[string]bool{}}
			a.logAnomalyState[svc.ID] = state
		}
		if now.Sub(state.lastScanned) < logScanInterval {
			continue
		}
		state.lastScanned = now
		toScan = append(toScan, svc)
	}
	// Drop state for containers no longer discovered (recreated with a new
	// ID, or removed) — otherwise this map grows for as long as the app
	// keeps running in the background, one entry per container ID ever
	// seen, the same leak class detectAnomalies already avoids for its own
	// per-service state.
	for id := range a.logAnomalyState {
		if !seen[id] {
			delete(a.logAnomalyState, id)
		}
	}
	a.logAnomalyMu.Unlock()

	if len(toScan) == 0 {
		return nil
	}

	// Fetching `docker logs` for several containers is independent I/O —
	// run it concurrently rather than paying N sequential round trips.
	findings := make([][]logFinding, len(toScan))
	var wg sync.WaitGroup
	for i, svc := range toScan {
		wg.Add(1)
		go func(i int, svc Service) {
			defer wg.Done()
			out, err := exec.CommandContext(ctx, "docker", "logs", "--tail", "200", svc.ContainerID).CombinedOutput()
			if err != nil {
				return
			}
			findings[i] = scanLogForAnomalies(string(out))
		}(i, svc)
	}
	wg.Wait()

	var anomalies []Anomaly
	a.logAnomalyMu.Lock()
	for i, svc := range toScan {
		state := a.logAnomalyState[svc.ID]
		for _, f := range findings[i] {
			if state.alerted[f.signature] {
				continue
			}
			state.alerted[f.signature] = true
			anomalies = append(anomalies, Anomaly{
				ServiceID: svc.ID,
				Name:      svc.Name,
				Project:   projectOrUnassigned(svc.Project),
				Kind:      "log_error",
				Severity:  f.severity,
				Message:   fmt.Sprintf("%s: %s", svc.Name, f.summary),
				Since:     now.Format(time.RFC3339),
			})
		}
	}
	a.logAnomalyMu.Unlock()

	return anomalies
}

type logFinding struct {
	signature string
	severity  string
	summary   string
}

// scanLogForAnomalies finds severe one-off patterns and repeated generic
// error/timeout lines in a log tail, normalizing each line (stripping
// digits — timestamps, ports, IDs) so near-identical lines dedupe to one
// signature instead of alerting once per line.
func scanLogForAnomalies(logText string) []logFinding {
	lineCounts := map[string]int{}
	lineExample := map[string]string{}
	seenSevere := map[string]bool{}
	var findings []logFinding

	for _, line := range strings.Split(logText, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		for _, pattern := range severeLogPatterns {
			if !pattern.MatchString(trimmed) {
				continue
			}
			sig := normalizeLogLine(trimmed)
			if seenSevere[sig] {
				continue
			}
			seenSevere[sig] = true
			findings = append(findings, logFinding{
				signature: "severe:" + sig,
				severity:  "critical",
				summary:   truncateForSummary(trimmed),
			})
		}
		for _, pattern := range repeatLogPatterns {
			if !pattern.MatchString(trimmed) {
				continue
			}
			sig := normalizeLogLine(trimmed)
			lineCounts[sig]++
			if _, ok := lineExample[sig]; !ok {
				lineExample[sig] = trimmed
			}
		}
	}
	for sig, count := range lineCounts {
		if count < logRepeatThreshold {
			continue
		}
		findings = append(findings, logFinding{
			signature: "repeat:" + sig,
			severity:  "warning",
			summary:   fmt.Sprintf("%q repeated %d times", truncateForSummary(lineExample[sig]), count),
		})
	}
	return findings
}

var logNormalizeDigits = regexp.MustCompile(`\d+`)

// normalizeLogLine strips digits so lines differing only in a timestamp,
// port, or ID still dedupe to the same signature.
func normalizeLogLine(line string) string {
	normalized := logNormalizeDigits.ReplaceAllString(line, "#")
	sum := sha1.Sum([]byte(normalized))
	return hex.EncodeToString(sum[:8])
}

func truncateForSummary(s string) string {
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}
