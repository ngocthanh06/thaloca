package security

import (
	"context"
	"sort"
	"time"
)

// ProgressFunc, if non-nil, is called as each scanner starts and finishes —
// scanner is "secrets"/"vulns"/"sast", phase is "start"/"done". Lets
// callers (the desktop app's "scan all repos" view) show live progress
// without this package needing to know anything about how it's displayed.
type ProgressFunc func(scanner, phase string)

type namedScanner struct {
	name string
	scan func(context.Context, string) ([]Finding, []ScannerStatus)
}

// Scan runs every scanner (secrets, vulns, sast) in parallel against path
// and aggregates their findings into one Report. Each scanner is
// independent and best-effort — one being skipped (its tool isn't
// installed) or failing never prevents the others from running or being
// reported; see each scanner's ScannerStatus for what actually ran.
func Scan(ctx context.Context, path string, onProgress ProgressFunc) Report {
	type result struct {
		findings []Finding
		statuses []ScannerStatus
	}

	scanners := []namedScanner{
		{"secrets", scanSecrets},
		{"vulns", scanVulns},
		{"sast", scanSast},
		{"malware", scanMalware},
	}
	resultsCh := make(chan result, len(scanners))
	for _, s := range scanners {
		go func(s namedScanner) {
			if onProgress != nil {
				onProgress(s.name, "start")
			}
			findings, statuses := s.scan(ctx, path)
			if onProgress != nil {
				onProgress(s.name, "done")
			}
			resultsCh <- result{findings: findings, statuses: statuses}
		}(s)
	}

	var allFindings []Finding
	var allStatuses []ScannerStatus
	for i := 0; i < len(scanners); i++ {
		r := <-resultsCh
		allFindings = append(allFindings, r.findings...)
		allStatuses = append(allStatuses, r.statuses...)
	}

	return buildReport(path, allFindings, allStatuses)
}

// buildReport sorts findings by severity and tallies Counts — shared by
// Scan (repo scans) and ScanImage (vulns.go, Docker image scans) so both
// produce the exact same Report shape for the frontend.
func buildReport(path string, findings []Finding, statuses []ScannerStatus) Report {
	sort.SliceStable(findings, func(i, j int) bool {
		return findings[i].Severity.Rank() > findings[j].Severity.Rank()
	})
	counts := map[Severity]int{}
	for _, f := range findings {
		counts[f.Severity]++
	}
	return Report{
		Path:      path,
		ScannedAt: time.Now(),
		Findings:  findings,
		Statuses:  statuses,
		Counts:    counts,
	}
}
