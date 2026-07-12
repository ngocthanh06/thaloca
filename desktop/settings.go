package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// GitEvent represents a commit or push event captured by an opt-in git hook.
type GitEvent struct {
	OccurredAt  string `json:"occurred_at"`
	RepoName    string `json:"repo_name"`
	RepoPath    string `json:"repo_path"`
	Event       string `json:"event"`
	Hash        string `json:"hash"`
	Subject     string `json:"subject"`
	Author      string `json:"author"`
	AuthorEmail string `json:"author_email"`
}

type userSettings struct {
	IgnoredRepos map[string]bool `json:"ignored_repos"`
	EventRepos   map[string]bool `json:"event_repos"`
	MineOnly     bool            `json:"mine_only"`
}

func defaultUserSettings() userSettings {
	return userSettings{IgnoredRepos: map[string]bool{}, EventRepos: map[string]bool{}, MineOnly: true}
}

func loadUserSettings() userSettings {
	settings := defaultUserSettings()
	path, err := settingsPath()
	if err != nil {
		return settings
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return settings
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return defaultUserSettings()
	}
	if settings.IgnoredRepos == nil {
		settings.IgnoredRepos = map[string]bool{}
	}
	if settings.EventRepos == nil {
		settings.EventRepos = map[string]bool{}
	}
	return settings
}

func saveUserSettings(settings userSettings) error {
	path, err := settingsPath()
	if err != nil {
		return err
	}
	if settings.IgnoredRepos == nil {
		settings.IgnoredRepos = map[string]bool{}
	}
	if settings.EventRepos == nil {
		settings.EventRepos = map[string]bool{}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func settingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "settings.json"), nil
}

func eventLogPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "events", "git-events.tsv"), nil
}

func installGitEventHooks(repo string) error {
	gitDir := filepath.Join(repo, ".git")
	info, err := os.Stat(gitDir)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not a normal git repository", repo)
	}
	hooksDir := filepath.Join(gitDir, "hooks")
	if err := os.MkdirAll(hooksDir, 0o755); err != nil {
		return err
	}
	// Git has no post-push hook; pre-push is the closest push-time hook.
	for hook, event := range map[string]string{"post-commit": "commit", "pre-push": "push"} {
		if err := installGitEventHook(repo, filepath.Join(hooksDir, hook), event); err != nil {
			return err
		}
	}
	return nil
}

func installGitEventHook(repo, hookPath, event string) error {
	if data, err := os.ReadFile(hookPath); err == nil {
		text := string(data)
		if strings.Contains(text, "THALOCA_GIT_EVENT_HOOK") {
			return nil
		}
		if strings.TrimSpace(text) != "" {
			return fmt.Errorf("%s already exists; refusing to overwrite user hook", hookPath)
		}
	}
	content := gitEventHookContent(repo, event)
	return os.WriteFile(hookPath, []byte(content), 0o755)
}

func removeGitEventHooks(repo string) error {
	// post-push is listed to clean up hooks installed by older versions.
	for _, hook := range []string{"post-commit", "pre-push", "post-push"} {
		hookPath := filepath.Join(repo, ".git", "hooks", hook)
		data, err := os.ReadFile(hookPath)
		if err != nil {
			continue
		}
		if strings.Contains(string(data), "THALOCA_GIT_EVENT_HOOK") {
			_ = os.Remove(hookPath)
		}
	}
	return nil
}

func gitEventHookContent(repo, event string) string {
	repoName := filepath.Base(repo)
	return fmt.Sprintf(`#!/bin/sh
# THALOCA_GIT_EVENT_HOOK
event_file="$HOME/.thaloca/events/git-events.tsv"
mkdir -p "$HOME/.thaloca/events"
repo_path=%s
repo_name=%s
event=%s
hash="$(git rev-parse --short HEAD 2>/dev/null || true)"
subject="$(git log -1 --pretty=%%s 2>/dev/null | tr '\t\n' '  ')"
author="$(git log -1 --pretty=%%an 2>/dev/null | tr '\t\n' '  ')"
email="$(git log -1 --pretty=%%ae 2>/dev/null | tr '\t\n' '  ')"
printf '%%s\t%%s\t%%s\t%%s\t%%s\t%%s\t%%s\t%%s\n' "$(date -u '+%%Y-%%m-%%dT%%H:%%M:%%SZ')" "$repo_path" "$repo_name" "$event" "$hash" "$subject" "$author" "$email" >> "$event_file"
exit 0
`, shellQuote(repo), shellQuote(repoName), shellQuote(event))
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func readGitEvents() []GitEvent {
	path, err := eventLogPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var events []GitEvent
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for _, line := range lines {
		fields := strings.Split(line, "\t")
		if len(fields) < 8 {
			continue
		}
		events = append(events, GitEvent{
			OccurredAt:  fields[0],
			RepoPath:    fields[1],
			RepoName:    fields[2],
			Event:       fields[3],
			Hash:        fields[4],
			Subject:     fields[5],
			Author:      fields[6],
			AuthorEmail: fields[7],
		})
	}
	sort.Slice(events, func(i, j int) bool {
		return events[i].OccurredAt > events[j].OccurredAt
	})
	if len(events) > 50 {
		return events[:50]
	}
	return events
}

func filterGitEvents(events []GitEvent, settings userSettings) []GitEvent {
	if len(settings.IgnoredRepos) == 0 {
		return events
	}
	var filtered []GitEvent
	for _, event := range events {
		if !settings.IgnoredRepos[event.RepoPath] {
			filtered = append(filtered, event)
		}
	}
	return filtered
}
