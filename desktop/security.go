package main

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"thaloca.local/thaloca/internal/security"
)

// RunSecurityScan runs a full security scan (secrets/vulns/sast — see
// internal/security) against path and returns the aggregated report.
// Read-only: never modifies anything at path. Gets its own longer timeout
// since a real scan (gitleaks/trivy/gosec/semgrep) commonly takes well
// past what the rest of the app's discovery scans need.
func (a *App) RunSecurityScan(path string) security.Report {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return security.Scan(ctx, path, nil)
}

// ScanContainerImage runs trivy against a running Docker container's image
// (not its filesystem — see internal/security.ScanImage) for the Runtime
// tab's per-container "Scan image" action. Read-only.
func (a *App) ScanContainerImage(image string) (security.Report, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	return security.ScanImage(ctx, image)
}

// GitHookStatus reports whether Thaloca's security-scan git hooks are
// currently installed in a repo, for the Source Control UI to show
// install vs. uninstall without keeping its own state.
type GitHookStatus struct {
	PreCommit bool `json:"pre_commit"`
	PrePush   bool `json:"pre_push"`
}

func (a *App) GetGitHookStatus(repoPath string) GitHookStatus {
	return GitHookStatus{
		PreCommit: security.HookInstalled(repoPath, security.HookPreCommit),
		PrePush:   security.HookInstalled(repoPath, security.HookPrePush),
	}
}

// InstallGitHook and UninstallGitHook add/remove Thaloca's security-scan
// block in repoPath's .git/hooks/<kind> (kind is "pre-commit" or
// "pre-push") — only ever touching that block, never a user's own
// pre-existing hook content in the same file (see internal/security/
// git_hooks.go).
func (a *App) InstallGitHook(repoPath, kind string) error {
	return security.InstallGitHook(repoPath, security.HookKind(kind))
}

func (a *App) UninstallGitHook(repoPath, kind string) error {
	return security.UninstallGitHook(repoPath, security.HookKind(kind))
}

// SecurityScanProgress is pushed to the frontend (event "security-scan-
// progress") as RunSecurityScanAll works through its repo list, so the
// "scan all repos" view can show real progress instead of a static
// "scanning..." message. Phase is one of "repo_start"/"repo_done"/
// "scanner_start"/"scanner_done"; Scanner is only set for the scanner_*
// phases ("secrets"/"vulns"/"sast").
type SecurityScanProgress struct {
	RepoPath  string `json:"repo_path"`
	RepoIndex int    `json:"repo_index"` // 1-based
	RepoTotal int    `json:"repo_total"`
	Scanner   string `json:"scanner,omitempty"`
	Phase     string `json:"phase"`
}

// RunSecurityScanAll scans each of the given repo paths (the caller — the
// top-level Security tab — lets the user pick which of Thaloca's
// discovered repos to include) and returns one Report per repo, in the
// same order as paths. Runs one repo at a time rather than in parallel:
// each scan already runs its own scanners concurrently and can take a
// while, and a strictly sequential repo order is what makes "repo 2 of 5"
// progress reporting meaningful instead of an ambiguous set of concurrent
// ones.
func (a *App) RunSecurityScanAll(paths []string) []security.Report {
	reports := make([]security.Report, len(paths))
	total := len(paths)
	for i, p := range paths {
		a.emitSecurityScanProgress(SecurityScanProgress{RepoPath: p, RepoIndex: i + 1, RepoTotal: total, Phase: "repo_start"})
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		reports[i] = security.Scan(ctx, p, func(scanner, phase string) {
			a.emitSecurityScanProgress(SecurityScanProgress{RepoPath: p, RepoIndex: i + 1, RepoTotal: total, Scanner: scanner, Phase: "scanner_" + phase})
		})
		cancel()
		a.emitSecurityScanProgress(SecurityScanProgress{RepoPath: p, RepoIndex: i + 1, RepoTotal: total, Phase: "repo_done"})
	}
	return reports
}

func (a *App) emitSecurityScanProgress(progress SecurityScanProgress) {
	wailsruntime.EventsEmit(a.ctx, "security-scan-progress", progress)
}

// OpenFileAtLine opens a security finding's file so the user can fix it —
// VS Code (`code -g file:line`) if it's on PATH, since it's the most common
// editor and directly supports jumping to a line; otherwise falls back to
// macOS's `open` (the file's default app, no line support). file may be
// relative to root (as scanner findings report it) or already absolute.
func (a *App) OpenFileAtLine(root, file string, line int) error {
	path := file
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, file)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if _, err := exec.LookPath("code"); err == nil {
		target := path
		if line > 0 {
			target = fmt.Sprintf("%s:%d", path, line)
		}
		cmd = exec.CommandContext(ctx, "code", "-g", target)
	} else {
		cmd = exec.CommandContext(ctx, "open", path)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}

// RevealFileInFinder shows a finding's file in Finder, selected — useful
// when there's no editor on PATH to jump straight to the line.
func (a *App) RevealFileInFinder(root, file string) error {
	path := file
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, file)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "open", "-R", path).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}
