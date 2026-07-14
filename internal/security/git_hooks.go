package security

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// HookKind is which git hook to install/uninstall.
type HookKind string

const (
	HookPreCommit HookKind = "pre-commit"
	HookPrePush   HookKind = "pre-push"
)

// hookMarkerStart/End delimit Thaloca's own block within a hook script so
// install/uninstall only ever touches that block — never a user's own
// existing pre-commit hook, husky, lefthook, etc. content in the same file.
const (
	hookMarkerStart = "# >>> thaloca security scan >>>"
	hookMarkerEnd   = "# <<< thaloca security scan <<<"
)

// hookScript is the shell block installed into .git/hooks/<kind>. Simpler
// than the original design's "staged files only" pre-commit idea: both
// hooks run a full `thaloca scan .` of the working tree — pre-commit with
// a lower bar (fail on high+) so it stays usable day to day, pre-push
// stricter (fail on critical only) since that's the last checkpoint before
// code leaves the machine. Calls back into the `thaloca` binary on PATH;
// if it's not there, the hook no-ops rather than blocking git entirely.
func hookScript(kind HookKind) string {
	failOn := "high"
	if kind == HookPrePush {
		failOn = "critical"
	}
	return fmt.Sprintf(`%s
if command -v thaloca >/dev/null 2>&1; then
  thaloca scan . --fail-on=%s
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "thaloca: security scan found issues at or above %s severity — fix them or re-run with --no-verify to skip" >&2
    exit "$status"
  fi
fi
%s
`, hookMarkerStart, failOn, failOn, hookMarkerEnd)
}

func hookPath(repoPath string, kind HookKind) (string, error) {
	gitDir := filepath.Join(repoPath, ".git")
	info, err := os.Stat(gitDir)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is not a git repository (no .git directory)", repoPath)
	}
	return filepath.Join(gitDir, "hooks", string(kind)), nil
}

// InstallGitHook adds Thaloca's security-scan block to repoPath's
// .git/hooks/<kind> — creating the file (with a shebang) if it doesn't
// exist, or appending to whatever's already there if it does. Safe to call
// again: it replaces its own block rather than duplicating it.
func InstallGitHook(repoPath string, kind HookKind) error {
	path, err := hookPath(repoPath, kind)
	if err != nil {
		return err
	}
	body := "#!/bin/sh\n"
	if existing, readErr := os.ReadFile(path); readErr == nil {
		stripped := stripHookBlock(string(existing))
		if strings.TrimSpace(stripped) != "" {
			body = stripped
		}
	}
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	body += hookScript(kind)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(body), 0o755)
}

// UninstallGitHook removes only Thaloca's own block from the hook file,
// leaving any pre-existing hook content untouched.
func UninstallGitHook(repoPath string, kind HookKind) error {
	path, err := hookPath(repoPath, kind)
	if err != nil {
		return err
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		return nil // nothing installed — already in the "uninstalled" state
	}
	return os.WriteFile(path, []byte(stripHookBlock(string(data))), 0o755)
}

func stripHookBlock(content string) string {
	start := strings.Index(content, hookMarkerStart)
	if start < 0 {
		return content
	}
	end := strings.Index(content, hookMarkerEnd)
	if end < 0 || end < start {
		return content
	}
	end += len(hookMarkerEnd)
	return content[:start] + content[end:]
}

// HookInstalled reports whether Thaloca's block is present in repoPath's
// .git/hooks/<kind> — lets callers (the desktop UI) show install vs.
// uninstall without keeping their own state.
func HookInstalled(repoPath string, kind HookKind) bool {
	path, err := hookPath(repoPath, kind)
	if err != nil {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(data), hookMarkerStart)
}
