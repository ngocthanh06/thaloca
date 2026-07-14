package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ConfigFileEntry describes one config file (or one telemetry setting found
// inside a config file) for the Config Files view. Only "shell" and "home"
// entries are ever toggleable — see the safety notes on ToggleConfigFile
// below for why global tool/telemetry config files are deliberately
// read-only here.
type ConfigFileEntry struct {
	ID            string `json:"id"`
	Category      string `json:"category"` // "shell" | "home" | "tool" | "telemetry"
	Name          string `json:"name"`
	Path          string `json:"path"`
	SourceName    string `json:"source_name,omitempty"`
	Exists        bool   `json:"exists"`
	Enabled       bool   `json:"enabled"`
	Toggleable    bool   `json:"toggleable"`
	Description   string `json:"description"`
	DetectedValue string `json:"detected_value,omitempty"`
}

type toolConfigDef struct {
	name        string
	relPath     string // relative to the user's home directory
	description string
}

// toolConfigDefs are well-known global dev-tool config files. They're
// listed for visibility only (existence + description) — most of them mix
// auth/identity with other settings (npm registry tokens, git identity,
// Docker credentials, Claude Code login state), so renaming one away to
// "disable" it would break far more than whatever a user might want off.
var toolConfigDefs = []toolConfigDef{
	{"Git global config", ".gitconfig", "Global git identity, aliases, and defaults for this machine."},
	{"npm global config", ".npmrc", "Global npm registry and auth settings for this machine."},
	{"Docker CLI config", filepath.Join(".docker", "config.json"), "Docker CLI login/auth config for this machine."},
	{"Claude Code state", ".claude.json", "Claude Code's local state file (login, per-project history, feature flags)."},
	{"Claude Code settings", filepath.Join(".claude", "settings.json"), "Claude Code's user-level settings (hooks, plugins, env overrides)."},
}

// claudeTelemetryEnvKeys are the environment variables Claude Code checks to
// control telemetry/error-reporting, as documented for Claude Code. They can
// be set as real shell env vars (invisible to a file scan) or inside
// settings.json's "env" object, which is the only place this can safely read
// them from.
var claudeTelemetryEnvKeys = []string{
	"CLAUDE_CODE_ENABLE_TELEMETRY",
	"DISABLE_TELEMETRY",
	"DISABLE_ERROR_REPORTING",
	"DISABLE_NON_ESSENTIAL_MODEL_CALLS",
}

// shellRCFiles are the shell startup files scanned for "source"/". " lines,
// relative to the user's home directory.
var shellRCFiles = []string{".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"}

// sourceLineRe finds a `source <path>` or `. <path>` invocation, whether it
// sits at the start of a line or after a shell operator like "&&"/"||" (the
// common `[ -f "path" ] && source "path"` guard form).
var sourceLineRe = regexp.MustCompile(`(?:^|&&|\|\|)\s*(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|(\S+))`)

// isGitTrackedAt reports whether name is a path git already knows about in
// the index of whatever repo (if any) contains dir — true whether or not it
// currently sits on disk under its tracked name or a ".disabled" rename,
// since git still lists a locally-deleted tracked path. Returns false (not
// an error) when dir isn't inside a git repo at all.
func isGitTrackedAt(dir, name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, "git", "-C", dir, "ls-files", "--error-unmatch", "--", name).Run()
	return err == nil
}

// shellSourceGuarded reports whether the matched line protects its
// source/. invocation against a missing file — either an explicit
// `[ -f ... ] &&` test, or a fallback like `|| :`/`|| true`, or stderr
// suppressed with `2>/dev/null`. Only guarded lines are offered as
// toggleable: renaming away a file sourced by an unguarded line would print
// a "no such file" error in every new shell.
func shellSourceGuarded(line string) bool {
	return strings.Contains(line, "-f ") ||
		strings.Contains(line, "2>/dev/null") ||
		strings.Contains(line, "|| :") ||
		strings.Contains(line, "|| true")
}

func resolveShellPath(home, raw string) string {
	raw = strings.TrimSpace(raw)
	switch {
	case raw == "~":
		raw = home
	case strings.HasPrefix(raw, "~/"):
		raw = filepath.Join(home, raw[2:])
	case strings.HasPrefix(raw, "$HOME/"):
		raw = filepath.Join(home, raw[len("$HOME/"):])
	}
	if !filepath.IsAbs(raw) {
		raw = filepath.Join(home, raw)
	}
	return filepath.Clean(raw)
}

// shellSourcedEntries scans known shell startup files for files they
// source and lists whichever of those actually exist on disk (active or
// already renamed to "<name>.disabled"). The rc file itself is never
// touched — only the smaller file it points to (e.g. a dedicated
// claude_telemetry.zsh) is ever renamed, and only when its source line is
// guarded against a missing file and it isn't tracked by git.
func shellSourcedEntries() []ConfigFileEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var entries []ConfigFileEntry
	seen := map[string]bool{}
	for _, rc := range shellRCFiles {
		data, readErr := os.ReadFile(filepath.Join(home, rc))
		if readErr != nil {
			continue
		}
		for lineNum, line := range strings.Split(string(data), "\n") {
			for _, m := range sourceLineRe.FindAllStringSubmatch(line, -1) {
				raw := m[1]
				if raw == "" {
					raw = m[2]
				}
				if raw == "" {
					raw = m[3]
				}
				if raw == "" {
					continue
				}
				full := resolveShellPath(home, raw)
				if seen[full] {
					continue
				}
				disabledPath := full + ".disabled"
				_, activeErr := os.Stat(full)
				_, disabledErr := os.Stat(disabledPath)
				if activeErr != nil && disabledErr != nil {
					continue
				}
				seen[full] = true

				guarded := shellSourceGuarded(line)
				tracked := isGitTrackedAt(filepath.Dir(full), filepath.Base(full))
				toggleable := guarded && !tracked
				description := fmt.Sprintf("Sourced from %s, line %d.", rc, lineNum+1)
				switch {
				case tracked:
					description += " Not toggleable: this file is committed to git."
				case !guarded:
					description += " Not toggleable: that source line isn't guarded against a missing file, so disabling it here would print an error in every new shell."
				default:
					description += " Its source line already skips it when missing, so switching it off here is safe."
				}

				entries = append(entries, ConfigFileEntry{
					ID:          full,
					Category:    "shell",
					Name:        filepath.Base(full),
					Path:        full,
					SourceName:  rc,
					Exists:      true,
					Enabled:     activeErr == nil,
					Toggleable:  toggleable,
					Description: description,
				})
			}
		}
	}
	return entries
}

// filesInDir lists every regular file sitting directly in dir, paired
// active/".disabled" the same way shellSourcedEntries is. When
// requireDotPrefix is true, only names starting with "." count (used for a
// directory like $HOME itself, where most files are irrelevant and a dot
// prefix is what marks something as a config file at all); when false,
// every regular file counts (used for a directory that's already hidden by
// virtue of its own name, like ~/.ssh, where the files inside — id_rsa,
// config, known_hosts — are never dot-prefixed themselves). skip excludes
// names already surfaced elsewhere so they don't show up twice. Not
// filtered by any "is this safe" guard beyond git-tracked status — there's
// no source line to check for a guard here, so the confirm dialog before
// disabling is the only safety net.
func filesInDir(dir string, requireDotPrefix bool, skip map[string]bool, describe func(name string, tracked bool) string) []ConfigFileEntry {
	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var entries []ConfigFileEntry
	for _, de := range dirEntries {
		name := de.Name()
		if de.IsDir() || (requireDotPrefix && !strings.HasPrefix(name, ".")) {
			continue
		}
		base := strings.TrimSuffix(name, ".disabled")
		if base == "" || base == "." || skip[base] || seen[base] {
			continue
		}
		seen[base] = true

		full := filepath.Join(dir, base)
		disabledPath := full + ".disabled"
		activeInfo, activeErr := os.Stat(full)
		disabledInfo, disabledErr := os.Stat(disabledPath)
		if activeErr != nil && disabledErr != nil {
			continue
		}
		// Skip sockets/devices/other non-regular files (e.g. an
		// ssh-agent or gpg-agent control socket) — renaming those isn't
		// "toggling a config file", it's poking a live IPC endpoint.
		info := activeInfo
		if info == nil {
			info = disabledInfo
		}
		if !info.Mode().IsRegular() {
			continue
		}

		tracked := isGitTrackedAt(dir, base)
		entries = append(entries, ConfigFileEntry{
			ID:          full,
			Category:    "home",
			Name:        base,
			Path:        full,
			Exists:      true,
			Enabled:     activeErr == nil,
			Toggleable:  !tracked,
			Description: describe(base, tracked),
		})
	}
	return entries
}

// knownHiddenConfigDirs are well-known credential/config directories worth
// looking inside, relative to home — deliberately a short allowlist rather
// than recursing into every hidden directory: some (.cache, .npm, .Trash,
// package-manager caches, ...) hold thousands of irrelevant files, and this
// keeps the sweep fast and focused on what's actually config. ".docker" and
// ".claude" are intentionally excluded — they're already represented
// read-only via toolConfigDefs/telemetryEntries, so scanning them here too
// would just duplicate those rows (or, for .claude, expose per-project
// history that isn't meant to be surfaced this broadly).
var knownHiddenConfigDirs = []string{".ssh", ".aws", ".gnupg", ".kube", ".azure", ".m2", ".terraform.d"}

// hiddenDirEntries looks inside knownHiddenConfigDirs, and one level deeper
// into ~/.config's own subdirectories (~/.config/gh, ~/.config/gcloud, ...
// — XDG's convention is a per-tool subfolder, not dot-prefixed files
// directly in ~/.config), for files that exist there. Everything found is
// still gated the same way as homeDotfileEntries: not toggleable if
// git-tracked, confirm dialog before disabling either way.
func hiddenDirEntries(home string, skip map[string]bool) []ConfigFileEntry {
	if home == "" {
		return nil
	}
	describe := func(location string) func(name string, tracked bool) string {
		return func(name string, tracked bool) string {
			if tracked {
				return fmt.Sprintf("Sitting in %s, but committed to git here, so Thaloca won't rename it.", location)
			}
			return fmt.Sprintf("Sitting in %s. Not referenced by any shell startup file Thaloca scanned, so switching it off just renames it — nothing else is known to react to that automatically.", location)
		}
	}

	// prefixNames rewrites each entry's bare filename to "<rel>/<name>" (e.g.
	// ".ssh/config") so two same-named files from different directories
	// (very possible for "config" or "credentials") read distinctly in the
	// list itself, not just in the description text below it.
	prefixNames := func(found []ConfigFileEntry, rel string) []ConfigFileEntry {
		for i := range found {
			found[i].Name = rel + "/" + found[i].Name
		}
		return found
	}

	var entries []ConfigFileEntry
	for _, name := range knownHiddenConfigDirs {
		dir := filepath.Join(home, name)
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		entries = append(entries, prefixNames(filesInDir(dir, false, skip, describe("~/"+name)), name)...)
	}

	configDir := filepath.Join(home, ".config")
	if subEntries, err := os.ReadDir(configDir); err == nil {
		for _, sub := range subEntries {
			if !sub.IsDir() {
				continue
			}
			dir := filepath.Join(configDir, sub.Name())
			rel := ".config/" + sub.Name()
			entries = append(entries, prefixNames(filesInDir(dir, false, skip, describe("~/"+rel)), rel)...)
		}
	}
	return entries
}

// homeDotfileEntries is the broader, unopinionated sweep on top of
// shellSourcedEntries: every dotfile sitting directly in the home folder,
// PLUS every dotfile sitting alongside each already-found shell-sourced
// file (e.g. a sibling test/draft script living next to the real one in a
// project folder outside home, not yet wired into any shell startup file).
func homeDotfileEntries(shell []ConfigFileEntry) []ConfigFileEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}

	dirs := []string{}
	if home != "" {
		dirs = append(dirs, home)
	}
	seenDir := map[string]bool{home: true}
	for _, e := range shell {
		dir := filepath.Dir(e.Path)
		if !seenDir[dir] {
			seenDir[dir] = true
			dirs = append(dirs, dir)
		}
	}

	skip := homeDotfileSkipSet(shell)
	var entries []ConfigFileEntry
	for _, dir := range dirs {
		isHome := dir == home
		entries = append(entries, filesInDir(dir, true, skip, func(name string, tracked bool) string {
			location := "in the same folder as a shell-sourced file Thaloca already found"
			if isHome {
				location = "directly in your home folder"
			}
			if tracked {
				return fmt.Sprintf("Sitting %s, but committed to git here, so Thaloca won't rename it.", location)
			}
			return fmt.Sprintf("Sitting %s. Not itself referenced by any shell startup file Thaloca scanned, so switching it off just renames it — nothing else is known to react to that automatically.", location)
		})...)
	}
	entries = append(entries, hiddenDirEntries(home, skip)...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries
}

// homeDotfileSkipSet lists names already surfaced elsewhere (shell rc files
// themselves, top-level tool config files, and anything shellSourcedEntries
// already found) so homeDotfileEntries doesn't repeat them.
func homeDotfileSkipSet(shell []ConfigFileEntry) map[string]bool {
	skip := map[string]bool{}
	for _, rc := range shellRCFiles {
		skip[rc] = true
	}
	for _, def := range toolConfigDefs {
		if !strings.Contains(def.relPath, string(filepath.Separator)) {
			skip[def.relPath] = true
		}
	}
	for _, e := range shell {
		skip[filepath.Base(e.Path)] = true
	}
	return skip
}

func toolConfigEntries() []ConfigFileEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var entries []ConfigFileEntry
	for _, def := range toolConfigDefs {
		full := filepath.Join(home, def.relPath)
		info, statErr := os.Stat(full)
		exists := statErr == nil && !info.IsDir()
		entries = append(entries, ConfigFileEntry{
			ID:          full,
			Category:    "tool",
			Name:        def.name,
			Path:        full,
			Exists:      exists,
			Enabled:     exists,
			Toggleable:  false,
			Description: def.description,
		})
	}
	return entries
}

// telemetryEntries reads Claude Code's settings.json (if present) and
// reports, read-only, which known telemetry-related environment variables
// are set inside its "env" block. It never edits this file: the same
// variables can also be set as real shell environment variables, which a
// file scan can't see, so this is inventory information rather than a
// reliable on/off switch.
func telemetryEntries() []ConfigFileEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	data, readErr := os.ReadFile(settingsPath)
	if readErr != nil {
		return []ConfigFileEntry{{
			ID:          settingsPath + "\x1ftelemetry",
			Category:    "telemetry",
			Name:        "Claude Code telemetry",
			Path:        settingsPath,
			Exists:      false,
			Enabled:     false,
			Toggleable:  false,
			Description: "No settings.json found here. Claude Code telemetry is controlled by env vars like CLAUDE_CODE_ENABLE_TELEMETRY, set either in your shell profile or in this file's \"env\" block — Thaloca only reads the file, never your shell environment.",
		}}
	}

	var parsed struct {
		Env map[string]string `json:"env"`
	}
	_ = json.Unmarshal(data, &parsed)

	var found []string
	for _, key := range claudeTelemetryEnvKeys {
		if value, ok := parsed.Env[key]; ok {
			found = append(found, fmt.Sprintf("%s=%s", key, value))
		}
	}

	entry := ConfigFileEntry{
		ID:         settingsPath + "\x1ftelemetry",
		Category:   "telemetry",
		Name:       "Claude Code telemetry",
		Path:       settingsPath,
		Exists:     true,
		Enabled:    false,
		Toggleable: false,
	}
	if len(found) == 0 {
		entry.Description = "None of Claude Code's telemetry env vars (CLAUDE_CODE_ENABLE_TELEMETRY, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, DISABLE_NON_ESSENTIAL_MODEL_CALLS) are set in this file's \"env\" block. They may still be set as real shell environment variables, which this can't see."
		entry.DetectedValue = "not set in settings.json"
	} else {
		entry.Description = "Values read from this file's \"env\" block."
		entry.DetectedValue = strings.Join(found, ", ")
	}
	return []ConfigFileEntry{entry}
}

// toggleableCandidates recomputes every entry ToggleConfigFile is allowed to
// act on — shell-sourced files plus general home dotfiles — fresh from
// disk each time, so a stale/forged path from the frontend can't reach
// anything not currently offered as toggleable.
func (a *App) toggleableCandidates() []ConfigFileEntry {
	shell := shellSourcedEntries()
	candidates := append([]ConfigFileEntry{}, shell...)
	candidates = append(candidates, homeDotfileEntries(shell)...)
	return candidates
}

// ListConfigFiles returns every known config file entry across all
// categories. Only "shell" and "home" entries can be toggleable; tool and
// telemetry entries are informational only (see ToggleConfigFile).
func (a *App) ListConfigFiles() []ConfigFileEntry {
	var entries []ConfigFileEntry
	entries = append(entries, a.toggleableCandidates()...)
	entries = append(entries, toolConfigEntries()...)
	entries = append(entries, telemetryEntries()...)
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Category != entries[j].Category {
			return entries[i].Category < entries[j].Category
		}
		return entries[i].Name < entries[j].Name
	})
	return entries
}

// ToggleConfigFile flips one shell-sourced or home-dotfile config file
// between active ("<name>") and disabled ("<name>.disabled") by renaming
// it, and returns the new enabled state. path must match a currently
// toggleable entry re-derived here, never trusted as given directly — same
// access model as envFiles.go's validateEnvFileAccess. This is why tool and
// telemetry entries (never toggleable) can't reach this at all.
func (a *App) ToggleConfigFile(path string) (bool, error) {
	var match *ConfigFileEntry
	for _, entry := range a.toggleableCandidates() {
		if entry.Path == path && entry.Toggleable {
			e := entry
			match = &e
			break
		}
	}
	if match == nil {
		return false, fmt.Errorf("unknown or non-toggleable config file")
	}

	disabledPath := match.Path + ".disabled"
	if match.Enabled {
		if err := os.Rename(match.Path, disabledPath); err != nil {
			return false, err
		}
		return false, nil
	}
	if err := os.Rename(disabledPath, match.Path); err != nil {
		return false, err
	}
	return true, nil
}
