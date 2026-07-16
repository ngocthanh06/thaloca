package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ToolInfo is one package-manager/CLI tool Thaloca can detect. Phase 1 is
// read-only: no command here ever installs or modifies anything.
type ToolInfo struct {
	Name      string `json:"name"`
	Command   string `json:"command"`
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	Path      string `json:"path,omitempty"`
	// InstallCommand/UpdateCommand are the literal command Thaloca would
	// run for that action (see desktop/toolActions.go), shown to the user
	// in a confirmation dialog before RunToolAction executes it. Empty
	// when that action isn't automatable here (e.g. Homebrew's own
	// install, or any action whose prerequisite binary isn't installed).
	InstallCommand string `json:"install_command,omitempty"`
	UpdateCommand  string `json:"update_command,omitempty"`
	// ManagedBy names the version manager (nvm/pyenv/volta/asdf) whose
	// install directory this tool's resolved binary lives under, if any —
	// when set, Install/Update aren't offered (see applyToolActionCommands
	// in toolActions.go), since adding a separate Homebrew-managed copy
	// wouldn't replace what the version manager already provides.
	ManagedBy string `json:"managed_by,omitempty"`
	// InstallBlockedReason explains why InstallCommand is empty even though
	// this tool isn't installed and isn't ManagedBy anything — its install
	// spec exists, but the spec's own prerequisite binary (almost always
	// Homebrew) isn't on this machine yet. Without this, a brand-new Mac
	// with no Homebrew shows every installable tool as a dead end with no
	// explanation (see applyToolActionCommands in toolActions.go).
	InstallBlockedReason string `json:"install_blocked_reason,omitempty"`
}

// ProjectToolRequirement is one discovered repo whose manifest files imply
// it needs a tool that isn't installed.
type ProjectToolRequirement struct {
	Project  string   `json:"project"`
	Path     string   `json:"path"`
	Required []string `json:"required"`
	Missing  []string `json:"missing"`
}

type ToolsSnapshot struct {
	Tools     []ToolInfo               `json:"tools"`
	Projects  []ProjectToolRequirement `json:"projects"`
	SampledAt string                   `json:"sampled_at"`
}

type toolSpec struct {
	Name        string
	Command     string
	VersionArgs []string
}

var toolSpecs = []toolSpec{
	{"Homebrew", "brew", []string{"--version"}},
	{"Node.js", "node", []string{"--version"}},
	{"npm", "npm", []string{"--version"}},
	{"pnpm", "pnpm", []string{"--version"}},
	{"Yarn", "yarn", []string{"--version"}},
	{"Bun", "bun", []string{"--version"}},
	{"Python", "python3", []string{"--version"}},
	{"pip", "pip3", []string{"--version"}},
	{"uv", "uv", []string{"--version"}},
	{"Composer", "composer", []string{"--version"}},
	{"Go", "go", []string{"version"}},
	{"Cargo", "cargo", []string{"--version"}},
	{"Docker", "docker", []string{"--version"}},
	// Optional tools the Security tab's scanners use when present (see
	// internal/security) — tracked here too so installing them is a single
	// click from this tab instead of a manual `brew install` in a terminal.
	{"gitleaks", "gitleaks", []string{"version"}},
	{"Trivy", "trivy", []string{"--version"}},
	{"gosec", "gosec", []string{"--version"}},
	{"Semgrep", "semgrep", []string{"--version"}},
	{"ClamAV", "clamscan", []string{"--version"}},
	// WireGuard and OpenVPN (used by the Servers view's per-server VPN
	// panel, see serverVPN.go) are deliberately NOT listed here — the VPN
	// engine picker itself detects them and offers the one-click install
	// (see ListVPNEngines), so listing them again here would be redundant.
}

// manifestRequirements is the simple 1-file-to-1-tool part of project
// detection. package.json and Python manifests need extra lockfile-based
// logic (which package manager) and are handled separately in
// detectProjectRequirements.
var manifestRequirements = []struct {
	File     string
	Commands []string
}{
	{"go.mod", []string{"go"}},
	{"Cargo.toml", []string{"cargo"}},
	{"composer.json", []string{"composer"}},
	{"Dockerfile", []string{"docker"}},
	{"docker-compose.yml", []string{"docker"}},
	{"docker-compose.yaml", []string{"docker"}},
	{"compose.yml", []string{"docker"}},
	{"compose.yaml", []string{"docker"}},
}

// Tools reports every supported package-manager/CLI tool's install status
// and version, plus which discovered repos are missing a tool their own
// manifest requires. Nothing here mutates the system. Serves the cached
// scan when one exists; call RefreshTools to force a live re-scan (that's
// what the Tools tab's "Refresh" button uses).
func (a *App) Tools() ToolsSnapshot {
	a.toolsMu.Lock()
	cached := a.toolsCache
	a.toolsMu.Unlock()
	if cached != nil {
		return *cached
	}
	return a.RefreshTools()
}

// RefreshTools always re-runs every tool's version command and re-scans
// discovered repos, then updates the cache Tools() serves from.
func (a *App) RefreshTools() ToolsSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tools := readTools(ctx)
	installed := make(map[string]bool, len(tools))
	for _, t := range tools {
		installed[t.Command] = t.Installed
	}
	applyToolActionCommands(tools, installed)

	snapshot := ToolsSnapshot{
		Tools:     tools,
		Projects:  a.readProjectToolGaps(installed),
		SampledAt: time.Now().Format(time.RFC3339),
	}

	a.toolsMu.Lock()
	a.toolsCache = &snapshot
	a.toolsMu.Unlock()

	return snapshot
}

func readTools(ctx context.Context) []ToolInfo {
	tools := make([]ToolInfo, len(toolSpecs))
	var wg sync.WaitGroup
	for i, spec := range toolSpecs {
		wg.Add(1)
		go func(i int, spec toolSpec) {
			defer wg.Done()
			tools[i] = readTool(ctx, spec)
		}(i, spec)
	}
	wg.Wait()
	return tools
}

func readTool(ctx context.Context, spec toolSpec) ToolInfo {
	info := ToolInfo{Name: spec.Name, Command: spec.Command}
	path, err := exec.LookPath(spec.Command)
	if err != nil {
		return info
	}
	info.Installed = true
	info.Path = path
	info.ManagedBy = versionManagerFor(path)
	if out, err := exec.CommandContext(ctx, spec.Command, spec.VersionArgs...).Output(); err == nil {
		info.Version = firstLine(string(out))
	}
	return info
}

// versionManagerFor reports which version manager (if any) appears to be
// managing a tool's resolved binary, based on well-known install
// directories for nvm, pyenv, volta, and asdf. Best-effort: a custom setup
// or an unusual install location just won't be recognized as managed.
func versionManagerFor(path string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	managers := []struct {
		name string
		dir  string
	}{
		{"nvm", filepath.Join(home, ".nvm")},
		{"pyenv", filepath.Join(home, ".pyenv")},
		{"volta", filepath.Join(home, ".volta")},
		{"asdf", filepath.Join(home, ".asdf")},
	}
	for _, m := range managers {
		if strings.HasPrefix(path, m.dir+string(os.PathSeparator)) {
			return m.name
		}
	}
	return ""
}

func firstLine(s string) string {
	line := strings.SplitN(strings.TrimSpace(s), "\n", 2)[0]
	return strings.TrimSpace(line)
}

// detectProjectRequirements inspects one repo's manifest files to guess
// which CLI tools it needs. This is a best-effort heuristic, not a real
// dependency resolver.
func detectProjectRequirements(path string) []string {
	exists := func(name string) bool {
		_, err := os.Stat(filepath.Join(path, name))
		return err == nil
	}

	required := map[string]bool{}

	if exists("package.json") {
		required["node"] = true
		switch {
		case exists("pnpm-lock.yaml"):
			required["pnpm"] = true
		case exists("yarn.lock"):
			required["yarn"] = true
		case exists("bun.lockb") || exists("bun.lock"):
			required["bun"] = true
		default:
			required["npm"] = true
		}
	}

	if exists("requirements.txt") || exists("pyproject.toml") || exists("Pipfile") {
		required["python3"] = true
		if exists("uv.lock") {
			required["uv"] = true
		} else {
			required["pip3"] = true
		}
	}

	for _, m := range manifestRequirements {
		if exists(m.File) {
			for _, c := range m.Commands {
				required[c] = true
			}
		}
	}

	names := make([]string, 0, len(required))
	for c := range required {
		names = append(names, c)
	}
	sort.Strings(names)
	return names
}

// readProjectToolGaps only returns repos with at least one missing tool —
// fully-satisfied projects add no useful signal here.
func (a *App) readProjectToolGaps(installed map[string]bool) []ProjectToolRequirement {
	var gaps []ProjectToolRequirement
	for _, path := range a.cachedRepoPaths(false) {
		required := detectProjectRequirements(path)
		if len(required) == 0 {
			continue
		}
		var missing []string
		for _, c := range required {
			if !installed[c] {
				missing = append(missing, c)
			}
		}
		if len(missing) == 0 {
			continue
		}
		gaps = append(gaps, ProjectToolRequirement{
			Project:  filepath.Base(path),
			Path:     path,
			Required: required,
			Missing:  missing,
		})
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].Project < gaps[j].Project })
	return gaps
}
