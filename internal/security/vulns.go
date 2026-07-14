package security

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// scanVulns checks project dependencies for known CVEs — trivy if
// installed (broadest ecosystem coverage: go.mod, package.json,
// requirements.txt, Cargo.toml, pom.xml, ...), else grype, else skipped
// entirely. There's no reasonable native fallback for a vulnerability
// database, unlike secrets.
func scanVulns(ctx context.Context, path string) ([]Finding, []ScannerStatus) {
	if _, err := exec.LookPath("trivy"); err == nil {
		findings, err := scanVulnsTrivy(ctx, path)
		if err == nil {
			return findings, []ScannerStatus{{Scanner: "vulns", Tool: "trivy"}}
		}
		return nil, []ScannerStatus{{Scanner: "vulns", Tool: "trivy", Skipped: true, Reason: err.Error()}}
	}
	if _, err := exec.LookPath("grype"); err == nil {
		findings, err := scanVulnsGrype(ctx, path)
		if err == nil {
			return findings, []ScannerStatus{{Scanner: "vulns", Tool: "grype"}}
		}
		return nil, []ScannerStatus{{Scanner: "vulns", Tool: "grype", Skipped: true, Reason: err.Error()}}
	}
	return nil, []ScannerStatus{{Scanner: "vulns", Skipped: true, Reason: "neither trivy nor grype is installed"}}
}

func normalizeVulnSeverity(s string) Severity {
	switch strings.ToUpper(s) {
	case "CRITICAL":
		return SeverityCritical
	case "HIGH":
		return SeverityHigh
	case "MEDIUM":
		return SeverityMedium
	default:
		return SeverityLow
	}
}

type trivyReport struct {
	Results []struct {
		Target          string `json:"Target"`
		Vulnerabilities []struct {
			VulnerabilityID  string `json:"VulnerabilityID"`
			PkgName          string `json:"PkgName"`
			InstalledVersion string `json:"InstalledVersion"`
			FixedVersion     string `json:"FixedVersion"`
			Title            string `json:"Title"`
			Severity         string `json:"Severity"`
		} `json:"Vulnerabilities"`
	} `json:"Results"`
}

// scanVulnsTrivy runs a filesystem scan (not a container image scan) —
// trivy walks the directory itself looking for known manifest files, so no
// pre-detection of project type is needed here.
func scanVulnsTrivy(ctx context.Context, path string) ([]Finding, error) {
	return runTrivy(ctx, "fs", path)
}

// ScanImage runs trivy against a Docker image (not a filesystem path) — for
// the Runtime tab's per-container "Scan image" action. No grype fallback
// here: grype's image-scan invocation ("grype <image>") differs enough
// from its dir scan ("grype dir:<path>") that one clear trivy-only path is
// simpler, and trivy is already this package's primary vuln scanner.
func ScanImage(ctx context.Context, image string) (Report, error) {
	if _, err := exec.LookPath("trivy"); err != nil {
		return Report{}, fmt.Errorf("trivy is not installed — install with `brew install trivy` to scan container images")
	}
	findings, err := runTrivy(ctx, "image", image)
	if err != nil {
		return Report{}, err
	}
	return buildReport(image, findings, []ScannerStatus{{Scanner: "vulns", Tool: "trivy"}}), nil
}

func runTrivy(ctx context.Context, mode, target string) ([]Finding, error) {
	out, err := exec.CommandContext(ctx, "trivy", mode, "--format", "json", "--quiet", target).Output()
	if err != nil {
		return nil, err
	}
	var report trivyReport
	if err := json.Unmarshal(out, &report); err != nil {
		return nil, err
	}
	var findings []Finding
	for _, result := range report.Results {
		for _, v := range result.Vulnerabilities {
			title := v.Title
			if title == "" {
				title = v.VulnerabilityID
			}
			detail := v.PkgName + "@" + v.InstalledVersion
			if v.FixedVersion != "" {
				detail += " (fix: " + v.FixedVersion + ")"
			}
			findings = append(findings, Finding{
				Scanner:  "vulns",
				Tool:     "trivy",
				Severity: normalizeVulnSeverity(v.Severity),
				Title:    title,
				Detail:   detail,
				File:     result.Target,
				RuleID:   v.VulnerabilityID,
			})
		}
	}
	return findings, nil
}

type grypeReport struct {
	Matches []struct {
		Vulnerability struct {
			ID       string `json:"id"`
			Severity string `json:"severity"`
			Fix      struct {
				Versions []string `json:"versions"`
			} `json:"fix"`
		} `json:"vulnerability"`
		Artifact struct {
			Name      string `json:"name"`
			Version   string `json:"version"`
			Locations []struct {
				Path string `json:"path"`
			} `json:"locations"`
		} `json:"artifact"`
	} `json:"matches"`
}

func scanVulnsGrype(ctx context.Context, path string) ([]Finding, error) {
	out, err := exec.CommandContext(ctx, "grype", "dir:"+path, "-o", "json").Output()
	if err != nil {
		return nil, err
	}
	var report grypeReport
	if err := json.Unmarshal(out, &report); err != nil {
		return nil, err
	}
	var findings []Finding
	for _, m := range report.Matches {
		detail := m.Artifact.Name + "@" + m.Artifact.Version
		if len(m.Vulnerability.Fix.Versions) > 0 {
			detail += " (fix: " + strings.Join(m.Vulnerability.Fix.Versions, ", ") + ")"
		}
		var file string
		if len(m.Artifact.Locations) > 0 {
			file = m.Artifact.Locations[0].Path
		}
		findings = append(findings, Finding{
			Scanner:  "vulns",
			Tool:     "grype",
			Severity: normalizeVulnSeverity(m.Vulnerability.Severity),
			Title:    m.Vulnerability.ID,
			Detail:   detail,
			File:     file,
			RuleID:   m.Vulnerability.ID,
		})
	}
	return findings, nil
}
