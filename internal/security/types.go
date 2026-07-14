// Package security implements Thaloca's security scanning: secrets, known
// dependency vulnerabilities, and static-analysis findings for a local
// project directory. Nothing here uploads anything anywhere — every
// scanner shells out to a locally-installed CLI tool (gitleaks, trivy,
// gosec, semgrep) and, for secrets, falls back to a native Go scan when no
// tool is installed, matching the rest of Thaloca's "optional tools, work
// with whatever's on the machine" philosophy (see internal/cron, internal/
// discovery).
package security

import "time"

// Severity is one of low/medium/high/critical, ordered by Rank.
type Severity string

const (
	SeverityLow      Severity = "low"
	SeverityMedium   Severity = "medium"
	SeverityHigh     Severity = "high"
	SeverityCritical Severity = "critical"
)

var severityRank = map[Severity]int{
	SeverityLow:      1,
	SeverityMedium:   2,
	SeverityHigh:     3,
	SeverityCritical: 4,
}

// Rank returns a comparable integer for this severity (higher = worse); an
// unrecognized value ranks at 0, below SeverityLow.
func (s Severity) Rank() int {
	return severityRank[s]
}

// AtLeast reports whether s is at least as severe as other.
func (s Severity) AtLeast(other Severity) bool {
	return s.Rank() >= other.Rank()
}

// Finding is one issue reported by a scanner. Detail must never contain an
// actual secret value — scanners redact matched secrets before returning.
type Finding struct {
	Scanner  string   `json:"scanner"` // "secrets" | "vulns" | "sast"
	Tool     string   `json:"tool"`    // e.g. "gitleaks", "trivy", "gosec"; "native" for the built-in secrets fallback
	Severity Severity `json:"severity"`
	Title    string   `json:"title"`
	Detail   string   `json:"detail,omitempty"`
	File     string   `json:"file,omitempty"`
	Line     int      `json:"line,omitempty"`
	RuleID   string   `json:"rule_id,omitempty"`
}

// ScannerStatus reports one scanner's own outcome, separate from its
// findings — a skipped tool ("gosec not installed") is scan-coverage
// metadata, not a Finding.
type ScannerStatus struct {
	Scanner string `json:"scanner"`
	Tool    string `json:"tool,omitempty"`
	Skipped bool   `json:"skipped"`
	Reason  string `json:"reason,omitempty"` // why skipped, or the error if it ran but failed
}

// Report is one full scan's aggregated result across every scanner run
// against Path.
type Report struct {
	Path      string           `json:"path"`
	ScannedAt time.Time        `json:"scanned_at"`
	Findings  []Finding        `json:"findings"`
	Statuses  []ScannerStatus  `json:"statuses"`
	Counts    map[Severity]int `json:"counts"`
}

// HighestSeverity returns the most severe finding's severity, or "" if
// there are no findings at all.
func (r Report) HighestSeverity() Severity {
	var highest Severity
	for _, f := range r.Findings {
		if f.Severity.Rank() > highest.Rank() {
			highest = f.Severity
		}
	}
	return highest
}
