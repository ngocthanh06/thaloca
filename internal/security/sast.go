package security

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// scanSast runs static-analysis tools against path: gosec for Go code
// (only attempted when a go.mod is present) and semgrep for everything
// else (its --config=auto picks rules per-language itself, so no project
// detection is needed for it). Each tool is entirely independent — one
// missing or failing doesn't affect the other — so both their statuses are
// returned rather than a single combined one.
func scanSast(ctx context.Context, path string) ([]Finding, []ScannerStatus) {
	var findings []Finding
	var statuses []ScannerStatus

	if _, err := os.Stat(filepath.Join(path, "go.mod")); err == nil {
		if _, lookErr := exec.LookPath("gosec"); lookErr == nil {
			f, err := scanSastGosec(ctx, path)
			if err != nil {
				statuses = append(statuses, ScannerStatus{Scanner: "sast", Tool: "gosec", Skipped: true, Reason: err.Error()})
			} else {
				findings = append(findings, f...)
				statuses = append(statuses, ScannerStatus{Scanner: "sast", Tool: "gosec"})
			}
		} else {
			statuses = append(statuses, ScannerStatus{Scanner: "sast", Tool: "gosec", Skipped: true, Reason: "gosec not installed"})
		}
	}

	if _, err := exec.LookPath("semgrep"); err == nil {
		f, err := scanSastSemgrep(ctx, path)
		if err != nil {
			statuses = append(statuses, ScannerStatus{Scanner: "sast", Tool: "semgrep", Skipped: true, Reason: err.Error()})
		} else {
			findings = append(findings, f...)
			statuses = append(statuses, ScannerStatus{Scanner: "sast", Tool: "semgrep"})
		}
	} else {
		statuses = append(statuses, ScannerStatus{Scanner: "sast", Tool: "semgrep", Skipped: true, Reason: "semgrep not installed"})
	}

	return findings, statuses
}

type gosecReport struct {
	Issues []struct {
		Severity string `json:"severity"`
		RuleID   string `json:"rule_id"`
		Details  string `json:"details"`
		File     string `json:"file"`
		Line     string `json:"line"` // gosec emits this as a string, not a number
	} `json:"Issues"`
}

// scanSastGosec runs from within path so its "./..." package pattern
// resolves against the project being scanned.
func scanSastGosec(ctx context.Context, path string) ([]Finding, error) {
	cmd := exec.CommandContext(ctx, "gosec", "-fmt=json", "-quiet", "./...")
	cmd.Dir = path
	out, runErr := cmd.Output()
	// gosec exits non-zero when it finds issues (that's expected, not a
	// failure) — its stdout is still valid JSON in that case, so only treat
	// this as a real failure if there's no output to parse at all.
	if len(out) == 0 {
		return nil, runErr
	}

	var report gosecReport
	if err := json.Unmarshal(out, &report); err != nil {
		if runErr != nil {
			return nil, runErr
		}
		return nil, err
	}

	findings := make([]Finding, 0, len(report.Issues))
	for _, issue := range report.Issues {
		rel := issue.File
		if r, err := filepath.Rel(path, issue.File); err == nil {
			rel = r
		}
		line, _ := strconv.Atoi(issue.Line)
		findings = append(findings, Finding{
			Scanner:  "sast",
			Tool:     "gosec",
			Severity: normalizeGosecSeverity(issue.Severity),
			Title:    issue.Details,
			File:     rel,
			Line:     line,
			RuleID:   issue.RuleID,
		})
	}
	return findings, nil
}

func normalizeGosecSeverity(s string) Severity {
	switch s {
	case "HIGH":
		return SeverityHigh
	case "MEDIUM":
		return SeverityMedium
	default:
		return SeverityLow
	}
}

type semgrepReport struct {
	Results []struct {
		CheckID string `json:"check_id"`
		Path    string `json:"path"`
		Start   struct {
			Line int `json:"line"`
		} `json:"start"`
		Extra struct {
			Message  string `json:"message"`
			Severity string `json:"severity"`
		} `json:"extra"`
	} `json:"results"`
}

func scanSastSemgrep(ctx context.Context, path string) ([]Finding, error) {
	cmd := exec.CommandContext(ctx, "semgrep", "--config=auto", "--json", "--quiet", path)
	out, runErr := cmd.Output()
	if len(out) == 0 {
		return nil, runErr
	}

	var report semgrepReport
	if err := json.Unmarshal(out, &report); err != nil {
		if runErr != nil {
			return nil, runErr
		}
		return nil, err
	}

	findings := make([]Finding, 0, len(report.Results))
	for _, r := range report.Results {
		rel := r.Path
		if rr, err := filepath.Rel(path, r.Path); err == nil {
			rel = rr
		}
		findings = append(findings, Finding{
			Scanner:  "sast",
			Tool:     "semgrep",
			Severity: normalizeSemgrepSeverity(r.Extra.Severity),
			Title:    r.Extra.Message,
			File:     rel,
			Line:     r.Start.Line,
			RuleID:   r.CheckID,
		})
	}
	return findings, nil
}

func normalizeSemgrepSeverity(s string) Severity {
	switch s {
	case "ERROR":
		return SeverityHigh
	case "WARNING":
		return SeverityMedium
	default:
		return SeverityLow
	}
}
