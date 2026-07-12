package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

func (a *App) FetchRepo(repo string) error {
	return runGitCommand(repo, 120*time.Second, "fetch", "--all", "--prune")
}

// PullRepo fast-forwards only; a diverged branch returns an error instead of
// creating a surprise merge commit.
func (a *App) PullRepo(repo string) error {
	return runGitCommand(repo, 180*time.Second, "pull", "--ff-only")
}

func (a *App) PushRepo(repo string) error {
	return runGitCommand(repo, 180*time.Second, "push")
}

func (a *App) StashSave(repo string) error {
	return runGitCommand(repo, 30*time.Second, "stash", "push", "--include-untracked")
}

func (a *App) StashPop(repo string) error {
	return runGitCommand(repo, 30*time.Second, "stash", "pop")
}

// StashList returns the stash entries of a repository.
func (a *App) StashList(repo string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "stash", "list").Output()
	if err != nil {
		return nil
	}
	var entries []string
	for _, line := range strings.Split(strings.TrimRight(string(output), "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			entries = append(entries, line)
		}
	}
	return entries
}

// FileChange is one changed path in the working tree.
type FileChange struct {
	Path     string `json:"path"`
	Status   string `json:"status"` // M, A, D, R, C, ?, U
	Staged   bool   `json:"staged"`
	Conflict bool   `json:"conflict"`
}

// GitChanges lists staged and unstaged changes. A partially staged file
// appears twice: once in the staged list and once in the unstaged list.
func (a *App) GitChanges(repo string) []FileChange {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// --untracked-files=all expands a wholly-untracked directory into its
	// individual files instead of collapsing it to one "dir/" entry, so
	// clicking into it in Changes shows the files inside, not a folder
	// that has no diff of its own.
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "status", "--porcelain", "-z", "--untracked-files=all").Output()
	if err != nil {
		return nil
	}
	changes := []FileChange{}
	entries := strings.Split(string(output), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		x, y := entry[0], entry[1]
		path := entry[3:]
		// Rename entries carry the original path as the next NUL field.
		if x == 'R' || x == 'C' {
			i++
		}
		conflict := x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D')
		if conflict {
			changes = append(changes, FileChange{Path: path, Status: "U", Conflict: true})
			continue
		}
		if x == '?' {
			changes = append(changes, FileChange{Path: path, Status: "?"})
			continue
		}
		if x != ' ' {
			changes = append(changes, FileChange{Path: path, Status: string(x), Staged: true})
		}
		if y != ' ' {
			changes = append(changes, FileChange{Path: path, Status: string(y)})
		}
	}
	return changes
}

// GitDiff returns the diff of one file (staged or unstaged). Untracked files
// are diffed against /dev/null so their content still shows.
func (a *App) GitDiff(repo, path string, staged bool) (string, error) {
	if _, err := repoSubPath(repo, path); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := []string{"-C", repo, "diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	output, err := exec.CommandContext(ctx, "git", args...).Output()
	if err == nil && len(strings.TrimSpace(string(output))) == 0 && !staged {
		// Likely untracked: git diff prints nothing for it.
		output, _ = exec.CommandContext(ctx, "git", "-C", repo, "diff", "--no-index", "--", os.DevNull, path).Output()
	}
	text := strings.TrimSpace(string(output))
	if text == "" {
		return "No changes to show.", nil
	}
	if len(text) > 200*1024 {
		text = text[:200*1024] + "\n\n… truncated …"
	}
	return text, nil
}

func (a *App) StageFile(repo, path string) error {
	if _, err := repoSubPath(repo, path); err != nil {
		return err
	}
	return runGitCommand(repo, 10*time.Second, "add", "--", path)
}

func (a *App) UnstageFile(repo, path string) error {
	if _, err := repoSubPath(repo, path); err != nil {
		return err
	}
	return runGitCommand(repo, 10*time.Second, "restore", "--staged", "--", path)
}

// CommitChanges commits what is currently staged.
func (a *App) CommitChanges(repo, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("commit message is empty")
	}
	return runGitCommand(repo, 15*time.Second, "commit", "-m", message)
}

// ResolveConflict resolves one conflicted file by keeping ours or theirs,
// then stages it.
func (a *App) ResolveConflict(repo, path, strategy string) error {
	if _, err := repoSubPath(repo, path); err != nil {
		return err
	}
	if strategy != "ours" && strategy != "theirs" {
		return fmt.Errorf("strategy must be ours or theirs")
	}
	if err := runGitCommand(repo, 10*time.Second, "checkout", "--"+strategy, "--", path); err != nil {
		return err
	}
	return runGitCommand(repo, 10*time.Second, "add", "--", path)
}

// ========== GitHub integration (OAuth device flow + REST API) ==========

// GitHubStatus describes whether PR features are usable for a repository.
