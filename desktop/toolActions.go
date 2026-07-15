package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// jobTimeout bounds how long a background command (tool install/update, SSH
// server command) may run before being killed — long enough for a real
// install, short enough that a hung command doesn't run forever.
const jobTimeout = 10 * time.Minute

// jobRetention is how long a finished job's entry stays in toolJobs after
// completion, giving the frontend time to poll its final status before it's
// evicted — without this, toolJobs would grow for the app's entire lifetime.
const jobRetention = 5 * time.Minute

// toolActionSpec is a fixed, hardcoded argv — never built from frontend
// input — so the actual shell surface stays auditable in this one file.
// The frontend only ever sends a tool command name ("node") and an action
// ("install"/"update"); RunToolAction looks the real command up here.
type toolActionSpec struct {
	Bin  string
	Args []string
}

func (s toolActionSpec) display() string {
	return strings.TrimSpace(s.Bin + " " + strings.Join(s.Args, " "))
}

// installSpecs installs a tool that's missing. Homebrew itself is
// deliberately not here: its official bootstrap script can prompt for a
// sudo password or an Enter keypress, which has no way to reach the user
// when run headless from this app and would just hang. Almost every tool
// below installs via Homebrew (requiring brew to already be present,
// enforced in applyToolActionCommands, not just here) — gosec is the one
// exception, installed via `go install` (requiring go instead).
var installSpecs = map[string]toolActionSpec{
	"node":     {"brew", []string{"install", "node"}},
	"pnpm":     {"brew", []string{"install", "pnpm"}},
	"yarn":     {"brew", []string{"install", "yarn"}},
	"bun":      {"brew", []string{"install", "oven-sh/bun/bun"}},
	"python3":  {"brew", []string{"install", "python3"}},
	"uv":       {"brew", []string{"install", "uv"}},
	"composer": {"brew", []string{"install", "composer"}},
	"go":       {"brew", []string{"install", "go"}},
	"cargo":    {"brew", []string{"install", "rust"}},
	"docker":   {"brew", []string{"install", "--cask", "docker"}},
	"gitleaks": {"brew", []string{"install", "gitleaks"}},
	"trivy":    {"brew", []string{"install", "trivy"}},
	"semgrep":  {"brew", []string{"install", "semgrep"}},
	"clamscan": {"brew", []string{"install", "clamav"}},
	// gosec has no homebrew-core formula — its own docs install it via
	// `go install`, so unlike everything else here this one requires `go`
	// (not brew) to already be present; applyToolActionCommands's
	// installed[spec.Bin] check handles that the same way either way.
	"gosec": {"go", []string{"install", "github.com/securego/gosec/v2/cmd/gosec@latest"}},
}

// updateSpecs upgrades a tool that's already installed. npm/pip update
// themselves rather than going through Homebrew, matching how most
// developers already update them by hand.
var updateSpecs = map[string]toolActionSpec{
	"brew":     {"brew", []string{"update"}},
	"node":     {"brew", []string{"upgrade", "node"}},
	"npm":      {"npm", []string{"install", "-g", "npm@latest"}},
	"pnpm":     {"brew", []string{"upgrade", "pnpm"}},
	"yarn":     {"brew", []string{"upgrade", "yarn"}},
	"bun":      {"brew", []string{"upgrade", "bun"}},
	"python3":  {"brew", []string{"upgrade", "python3"}},
	"pip3":     {"pip3", []string{"install", "--upgrade", "pip"}},
	"uv":       {"brew", []string{"upgrade", "uv"}},
	"composer": {"brew", []string{"upgrade", "composer"}},
	"go":       {"brew", []string{"upgrade", "go"}},
	"cargo":    {"brew", []string{"upgrade", "rust"}},
	"docker":   {"brew", []string{"upgrade", "--cask", "docker"}},
}

// applyToolActionCommands fills in InstallCommand/UpdateCommand on each
// ToolInfo, but only when the spec's own binary (almost always brew) is
// itself installed — otherwise the button would just fail immediately. When
// that prerequisite is missing, InstallBlockedReason explains why instead
// of just leaving the tool with no action and no explanation (the common
// case on a brand-new Mac with no Homebrew yet).
func applyToolActionCommands(tools []ToolInfo, installed map[string]bool) {
	for i := range tools {
		t := &tools[i]
		if t.ManagedBy != "" {
			// Already managed by a version manager — a Homebrew-managed
			// copy would just sit alongside it, not replace it.
			continue
		}
		if !t.Installed {
			if spec, ok := installSpecs[t.Command]; ok {
				if installed[spec.Bin] {
					t.InstallCommand = spec.display()
				} else {
					t.InstallBlockedReason = installPrereqMessage(spec.Bin)
				}
			}
			continue
		}
		if spec, ok := updateSpecs[t.Command]; ok && installed[spec.Bin] {
			t.UpdateCommand = spec.display()
		}
	}
}

// homebrewInstallCommand is Homebrew's own official bootstrap one-liner
// (https://brew.sh). Thaloca never runs this itself — see installSpecs'
// comment above on why (it can prompt for a sudo password or an Enter
// keypress, which has no way to reach the user when run headless) — this is
// only staged in a real Terminal window so the user runs it themselves and
// answers any such prompt normally.
const homebrewInstallCommand = `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`

// OpenHomebrewInstallInTerminal opens Terminal.app with Homebrew's official
// install command staged (not run) in a new window. This is the one path
// off the "Requires Homebrew" dead end shown on a brand-new Mac that has
// nothing else in installSpecs available yet.
func (a *App) OpenHomebrewInstallInTerminal() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	escaped := strings.ReplaceAll(homebrewInstallCommand, `"`, `\"`)
	script := fmt.Sprintf(`tell application "Terminal"
	activate
	do script "%s"
end tell`, escaped)
	out, err := exec.CommandContext(ctx, "osascript", "-e", script).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}

// installPrereqMessage explains what to install first when an install
// spec's own binary (bin) isn't present yet. Thaloca deliberately never
// runs Homebrew's own install script itself (see installSpecs' comment on
// why), so this is guidance, not something Install here can fix directly.
func installPrereqMessage(bin string) string {
	switch bin {
	case "brew":
		return "Requires Homebrew — install it from https://brew.sh, then refresh this tab."
	case "go":
		return "Requires Go — install Go first (e.g. from https://go.dev/dl/), then refresh this tab."
	default:
		return "Requires " + bin + " to be installed first, then refresh this tab."
	}
}

// toolJob tracks one running install/update command's live output so the
// frontend can poll it while the command runs (Wails bindings are
// request/response, not a stream, so polling is the simplest way to show
// progress as it happens rather than only after the command exits).
type toolJob struct {
	mu       sync.Mutex
	buf      strings.Builder
	running  bool
	exitCode int
	err      string
}

func (j *toolJob) Write(p []byte) (int, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.buf.Write(p)
}

// ToolActionStatus is what ToolActionStatus() returns on each poll.
type ToolActionStatus struct {
	Running  bool   `json:"running"`
	Output   string `json:"output"`
	ExitCode int    `json:"exit_code"`
	Error    string `json:"error,omitempty"`
}

func lookupActionSpec(tool, action string) (toolActionSpec, bool) {
	switch action {
	case "install":
		spec, ok := installSpecs[tool]
		return spec, ok
	case "update":
		spec, ok := updateSpecs[tool]
		return spec, ok
	default:
		return toolActionSpec{}, false
	}
}

// startJob runs bin/args in the background against a fresh job entry,
// returns its ID immediately, and calls onDone (if not nil) once it exits.
// Shared by RunToolAction and RunServerCommand (desktop/servers.go) — both
// are "run a real command, let the frontend poll for live output" actions,
// just with a different source for bin/args.
func (a *App) startJob(prefix string, bin string, args []string, onDone func()) string {
	jobID := fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	job := &toolJob{running: true}

	a.toolJobsMu.Lock()
	if a.toolJobs == nil {
		a.toolJobs = map[string]*toolJob{}
	}
	a.toolJobs[jobID] = job
	a.toolJobsMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), jobTimeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, args...)
		cmd.Stdout = job
		cmd.Stderr = job
		runErr := cmd.Run()

		job.mu.Lock()
		job.running = false
		if runErr != nil {
			job.err = runErr.Error()
			if exitErr, ok := runErr.(*exec.ExitError); ok {
				job.exitCode = exitErr.ExitCode()
			} else {
				job.exitCode = -1
			}
		}
		job.mu.Unlock()

		if onDone != nil {
			onDone()
		}

		time.AfterFunc(jobRetention, func() {
			a.toolJobsMu.Lock()
			delete(a.toolJobs, jobID)
			a.toolJobsMu.Unlock()
		})
	}()

	return jobID
}

// RunToolAction starts an install/update command in the background and
// returns a job ID immediately; poll ToolActionStatus(jobID) for output and
// completion. The frontend is expected to have already shown the user the
// exact command (via ToolInfo.InstallCommand/UpdateCommand) and gotten a
// native confirmation before calling this.
func (a *App) RunToolAction(tool, action string) (string, error) {
	spec, ok := lookupActionSpec(tool, action)
	if !ok {
		return "", fmt.Errorf("no automated %s action for %q", action, tool)
	}
	if _, err := exec.LookPath(spec.Bin); err != nil {
		return "", fmt.Errorf("%s is not installed", spec.Bin)
	}

	jobID := a.startJob(tool+"-"+action, spec.Bin, spec.Args, func() {
		// The install/update just changed reality, so the cached scan is
		// stale — drop it rather than wait for an explicit Refresh.
		a.toolsMu.Lock()
		a.toolsCache = nil
		a.toolsMu.Unlock()
	})

	return jobID, nil
}

// ToolActionStatus reports a running or finished job's accumulated output.
func (a *App) ToolActionStatus(jobID string) ToolActionStatus {
	a.toolJobsMu.Lock()
	job := a.toolJobs[jobID]
	a.toolJobsMu.Unlock()
	if job == nil {
		return ToolActionStatus{Error: "unknown job"}
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	return ToolActionStatus{
		Running:  job.running,
		Output:   job.buf.String(),
		ExitCode: job.exitCode,
		Error:    job.err,
	}
}
