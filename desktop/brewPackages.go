package main

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// isSafeBrewName rejects anything that isn't a plausible Homebrew formula or
// cask name — in particular a leading "-", which `exec.Command`'s argv-based
// invocation (never a shell string) already can't turn into shell injection,
// but could still be misread by brew itself as a flag. Taps like
// "oven-sh/bun/bun" (already used in installSpecs, desktop/toolActions.go)
// need "/" allowed, hence the dedicated charset instead of reusing
// isSafeSSHArg's simpler "no leading dash" check.
var safeBrewNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@/-]*$`)

func isSafeBrewName(name string) bool {
	return safeBrewNamePattern.MatchString(name)
}

// BrewSearchResult is one match from SearchBrewPackages.
type BrewSearchResult struct {
	Name   string `json:"name"`
	IsCask bool   `json:"is_cask"`
}

// BrewPackages is what's already installed, grouped the way `brew` itself
// distinguishes them.
type BrewPackages struct {
	// Formulae comes from `brew leaves` (top-level/explicitly-installed
	// formulae only) rather than `brew list --formula`, which would also
	// list every transitive library dependency — not something a user
	// would recognize as "a package I installed".
	Formulae []string `json:"formulae"`
	Casks    []string `json:"casks"`
}

// SearchBrewPackages runs `brew search` for formulae and casks separately
// (rather than one combined search) since brew's combined-search plain-text
// output has no reliable machine-readable marker between the two sections —
// `--formula`/`--cask` each give an unambiguous one-name-per-line list.
func (a *App) SearchBrewPackages(query string) ([]BrewSearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("enter a package name to search for")
	}
	if _, err := exec.LookPath("brew"); err != nil {
		return nil, fmt.Errorf("brew is not installed")
	}

	var results []BrewSearchResult
	formulae, err := runBrewSearch("--formula", query)
	if err != nil {
		return nil, err
	}
	for _, name := range formulae {
		results = append(results, BrewSearchResult{Name: name, IsCask: false})
	}
	casks, err := runBrewSearch("--cask", query)
	if err != nil {
		return nil, err
	}
	for _, name := range casks {
		results = append(results, BrewSearchResult{Name: name, IsCask: true})
	}
	return results, nil
}

func runBrewSearch(kindFlag, query string) ([]string, error) {
	out, err := exec.Command("brew", "search", kindFlag, query).CombinedOutput()
	if err != nil {
		// `brew search` exits non-zero when nothing matches — not a real
		// error the user needs to see, just an empty result set.
		if strings.Contains(strings.ToLower(string(out)), "no formula or cask") {
			return nil, nil
		}
		return nil, fmt.Errorf("brew search: %s", strings.TrimSpace(string(out)))
	}
	return splitNonEmptyLines(string(out)), nil
}

func splitNonEmptyLines(s string) []string {
	var lines []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// ListBrewPackages reports what's currently installed, for the Tools tab's
// grouped "installed packages" list. Always runs fresh (no caching) — both
// underlying brew commands are fast single-shot reads.
func (a *App) ListBrewPackages() (BrewPackages, error) {
	if _, err := exec.LookPath("brew"); err != nil {
		return BrewPackages{}, fmt.Errorf("brew is not installed")
	}
	formulaeOut, err := exec.Command("brew", "leaves").CombinedOutput()
	if err != nil {
		return BrewPackages{}, fmt.Errorf("brew leaves: %s", strings.TrimSpace(string(formulaeOut)))
	}
	casksOut, err := exec.Command("brew", "list", "--cask").CombinedOutput()
	if err != nil {
		// A machine with zero casks installed exits non-zero here rather
		// than printing an empty list — treat that the same as "none".
		if !strings.Contains(strings.ToLower(string(casksOut)), "no casks") {
			return BrewPackages{}, fmt.Errorf("brew list --cask: %s", strings.TrimSpace(string(casksOut)))
		}
	}
	return BrewPackages{
		Formulae: splitNonEmptyLines(string(formulaeOut)),
		Casks:    splitNonEmptyLines(string(casksOut)),
	}, nil
}

// InstallBrewPackage starts `brew install [--cask] <name>` in the background
// and returns a job ID immediately; poll it via the existing
// ToolActionStatus(jobID) binding (desktop/toolActions.go), same as
// RunToolAction/RunServerCommand. The frontend is expected to have already
// shown the user the exact command and gotten a native confirmation before
// calling this.
func (a *App) InstallBrewPackage(name string, isCask bool) (string, error) {
	if !isSafeBrewName(name) {
		return "", fmt.Errorf("%q is not a valid package name", name)
	}
	if _, err := exec.LookPath("brew"); err != nil {
		return "", fmt.Errorf("brew is not installed")
	}
	args := []string{"install"}
	if isCask {
		args = append(args, "--cask")
	}
	args = append(args, name)
	return a.startJob("brew-install-"+name, "brew", args, nil), nil
}

// UninstallBrewPackage starts `brew uninstall [--cask] <name>` in the
// background — same shape as InstallBrewPackage.
func (a *App) UninstallBrewPackage(name string, isCask bool) (string, error) {
	if !isSafeBrewName(name) {
		return "", fmt.Errorf("%q is not a valid package name", name)
	}
	if _, err := exec.LookPath("brew"); err != nil {
		return "", fmt.Errorf("brew is not installed")
	}
	args := []string{"uninstall"}
	if isCask {
		args = append(args, "--cask")
	}
	args = append(args, name)
	return a.startJob("brew-uninstall-"+name, "brew", args, nil), nil
}
