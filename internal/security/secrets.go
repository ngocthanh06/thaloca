package security

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// scanSecrets detects likely hardcoded secrets under path — gitleaks if
// installed, otherwise a native regex-based fallback. Neither ever returns
// the actual matched secret value in a Finding; only a redacted form.
func scanSecrets(ctx context.Context, path string) ([]Finding, []ScannerStatus) {
	if _, err := exec.LookPath("gitleaks"); err == nil {
		findings, err := scanSecretsGitleaks(ctx, path)
		if err == nil {
			return findings, []ScannerStatus{{Scanner: "secrets", Tool: "gitleaks"}}
		}
		// gitleaks itself failed to run (not "found nothing") — fall through
		// to the native fallback rather than reporting no coverage at all.
	}
	findings, err := scanSecretsNative(path)
	if err != nil {
		return nil, []ScannerStatus{{Scanner: "secrets", Tool: "native", Skipped: true, Reason: err.Error()}}
	}
	return findings, []ScannerStatus{{Scanner: "secrets", Tool: "native"}}
}

type gitleaksFinding struct {
	RuleID      string `json:"RuleID"`
	Description string `json:"Description"`
	File        string `json:"File"`
	StartLine   int    `json:"StartLine"`
	Match       string `json:"Match"`
}

// scanSecretsGitleaks runs gitleaks against the working directory (not git
// history — this needs to work just as well right after a fresh clone or
// before there's any history at all) and parses its JSON report.
func scanSecretsGitleaks(ctx context.Context, path string) ([]Finding, error) {
	reportFile, err := os.CreateTemp("", "thaloca-gitleaks-*.json")
	if err != nil {
		return nil, err
	}
	reportPath := reportFile.Name()
	reportFile.Close()
	defer os.Remove(reportPath)

	cmd := exec.CommandContext(ctx, "gitleaks", "detect",
		"--source", path,
		"--no-git",
		"--report-format", "json",
		"--report-path", reportPath,
		"--exit-code", "0", // findings are expected to be common — read the report file instead of relying on exit code
	)
	if err := cmd.Run(); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(reportPath)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil, nil
	}
	var raw []gitleaksFinding
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	findings := make([]Finding, 0, len(raw))
	for _, f := range raw {
		rel := f.File
		if r, err := filepath.Rel(path, f.File); err == nil {
			rel = r
		}
		findings = append(findings, Finding{
			Scanner:  "secrets",
			Tool:     "gitleaks",
			Severity: SeverityCritical,
			Title:    f.Description,
			Detail:   "Matched pattern: " + redactSecret(f.Match),
			File:     rel,
			Line:     f.StartLine,
			RuleID:   f.RuleID,
		})
	}
	return findings, nil
}

// secretPatterns are best-effort heuristics for when gitleaks isn't
// installed — nowhere near as thorough, but still catches the most common,
// highest-impact mistakes (cloud keys, private key files, tokens).
var secretPatterns = []struct {
	name    string
	pattern *regexp.Regexp
}{
	{"AWS Access Key ID", regexp.MustCompile(`AKIA[0-9A-Z]{16}`)},
	{"Private key file", regexp.MustCompile(`-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----`)},
	{"Slack token", regexp.MustCompile(`xox[baprs]-[0-9A-Za-z-]{10,}`)},
	{"GitHub token", regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{36}`)},
	{"Hardcoded API key/secret/token/password", regexp.MustCompile(`(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{12,}['"]`)},
}

var secretSkipDirNames = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true,
	"build": true, ".venv": true, "venv": true, "__pycache__": true,
	".next": true, ".turbo": true,
}

// maxScannedFileSize skips large files (binaries, lockfiles, bundles) —
// secrets worth flagging live in small, hand-written source/config files.
const maxScannedFileSize = 1 << 20 // 1MB

func scanSecretsNative(root string) ([]Finding, error) {
	var findings []Finding
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // best-effort — skip unreadable entries rather than aborting the scan
		}
		if d.IsDir() {
			if secretSkipDirNames[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() == 0 || info.Size() > maxScannedFileSize {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil || looksBinary(data) {
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			rel = p
		}
		for lineNum, line := range strings.Split(string(data), "\n") {
			for _, pat := range secretPatterns {
				if loc := pat.pattern.FindStringIndex(line); loc != nil {
					findings = append(findings, Finding{
						Scanner:  "secrets",
						Tool:     "native",
						Severity: SeverityHigh,
						Title:    pat.name + " detected",
						Detail:   "Matches pattern for " + pat.name,
						File:     rel,
						Line:     lineNum + 1,
					})
				}
			}
		}
		return nil
	})
	return findings, err
}

func looksBinary(data []byte) bool {
	limit := len(data)
	if limit > 512 {
		limit = 512
	}
	for _, b := range data[:limit] {
		if b == 0 {
			return true
		}
	}
	return false
}

// redactSecret keeps only a few characters at each end so a Finding can
// still show roughly what matched without leaking the actual secret value.
func redactSecret(s string) string {
	if len(s) <= 8 {
		return "[redacted]"
	}
	return s[:4] + "…[redacted]…" + s[len(s)-4:]
}
