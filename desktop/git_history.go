package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func shortCommitHash(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}

type RepoBranch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

// RepoEntry is a file or directory inside a repository.
type RepoEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size"`
}

// RepoCommits returns a page of the current branch's history; skip allows
// "load more" paging through the full log.
func (a *App) RepoCommits(repo string, limit, skip int) []Commit {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if skip < 0 {
		skip = 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "log",
		"-n", fmt.Sprintf("%d", limit),
		"--skip", fmt.Sprintf("%d", skip),
		"--date=iso-strict",
		"--pretty=format:%H%x1f%s%x1f%an%x1f%ae%x1f%aI",
	).Output()
	if err != nil {
		return nil
	}
	return parseGitLog(string(output), repo)
}

// RepoBranches lists local branches, marking the current one.
func (a *App) RepoBranches(repo string) []RepoBranch {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "branch",
		"--list", "--format", "%(HEAD)\t%(refname:short)").Output()
	if err != nil {
		return nil
	}
	var branches []RepoBranch
	// TrimRight only: TrimSpace would eat the leading " \t" of the first
	// line and silently drop that branch when it is not the current one.
	for _, line := range strings.Split(strings.TrimRight(string(output), "\n"), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[1]) == "" {
			continue
		}
		branches = append(branches, RepoBranch{Name: strings.TrimSpace(parts[1]), Current: parts[0] == "*"})
	}
	return branches
}

func validBranchName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("branch name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "git", "check-ref-format", "--branch", name).Run(); err != nil {
		return fmt.Errorf("invalid branch name: %s", name)
	}
	return nil
}

func runGitCommand(repo string, timeout time.Duration, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	fullArgs := append([]string{"-C", repo}, args...)
	output, err := exec.CommandContext(ctx, "git", fullArgs...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("git %s: %s", args[0], message)
	}
	return nil
}

func (a *App) CreateBranch(repo, name string) error {
	if err := validBranchName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 5*time.Second, "branch", "--", strings.TrimSpace(name))
}

// DeleteBranch uses -d (safe delete): git refuses to delete unmerged branches
// and that refusal is surfaced to the UI.
func (a *App) DeleteBranch(repo, name string) error {
	if err := validBranchName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 5*time.Second, "branch", "-d", "--", strings.TrimSpace(name))
}

func (a *App) SwitchBranch(repo, name string) error {
	if err := validBranchName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 10*time.Second, "switch", strings.TrimSpace(name))
}

// hasUnmergedPaths reports whether the working tree currently has any
// conflicted ("U") path — i.e. a merge/rebase is genuinely mid-resolution,
// as opposed to having failed for some other reason (bad ref, dirty
// worktree blocking the merge, etc).
func hasUnmergedPaths(repo string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", repo, "diff", "--name-only", "--diff-filter=U").Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// MergeBranch merges the named branch into the current branch. A real
// conflict is left in place (not aborted) so the Changes tab's existing
// Conflicts panel (resolve ours/theirs, then Commit) can finish it — only a
// non-conflict failure (invalid branch, dirty worktree blocking the merge)
// aborts, since there's nothing there for the user to resolve.
func (a *App) MergeBranch(repo, name string) error {
	if err := validBranchName(name); err != nil {
		return err
	}
	if err := runGitCommand(repo, 30*time.Second, "merge", "--no-edit", "--", strings.TrimSpace(name)); err != nil {
		if !hasUnmergedPaths(repo) {
			_ = runGitCommand(repo, 10*time.Second, "merge", "--abort")
		}
		return err
	}
	return nil
}

// ========== Commit graph & sync ==========

// GraphCommit is one node of the commit graph (all branches).
type GraphCommit struct {
	Hash       string   `json:"hash"`
	Parents    []string `json:"parents"`
	Refs       []string `json:"refs"`
	Head       bool     `json:"head"` // commit is the current HEAD
	Subject    string   `json:"subject"`
	Author     string   `json:"author"`
	OccurredAt string   `json:"occurred_at"`
}

// RepoGraph returns recent commits across all branches in topological order,
// with parent hashes and ref names so the UI can draw a graph.
func (a *App) RepoGraph(repo string, limit int) []GraphCommit {
	if limit <= 0 {
		limit = 120
	}
	// Clamp instead of resetting so "load more" keeps growing.
	if limit > 2000 {
		limit = 2000
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "log", "--all", "--topo-order",
		"-n", fmt.Sprintf("%d", limit),
		"--pretty=format:%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%aI").Output()
	if err != nil {
		return nil
	}
	var commits []GraphCommit
	for _, line := range strings.Split(string(output), "\n") {
		parts := strings.Split(line, "\x1f")
		if len(parts) != 6 {
			continue
		}
		commit := GraphCommit{Hash: parts[0], Subject: parts[3], Author: parts[4], OccurredAt: parts[5]}
		if parts[1] != "" {
			commit.Parents = strings.Fields(parts[1])
		}
		for _, ref := range strings.Split(parts[2], ", ") {
			ref = strings.TrimSpace(ref)
			if ref == "" {
				continue
			}
			if strings.HasPrefix(ref, "HEAD -> ") {
				commit.Head = true
				ref = strings.TrimPrefix(ref, "HEAD -> ")
			}
			if ref == "HEAD" {
				commit.Head = true
				continue
			}
			commit.Refs = append(commit.Refs, ref)
		}
		commits = append(commits, commit)
	}
	return commits
}

// repoSubPath resolves rel inside repo and rejects paths that escape it.
func repoSubPath(repo, rel string) (string, error) {
	base := filepath.Clean(repo)
	target := filepath.Clean(filepath.Join(base, rel))
	if target != base && !strings.HasPrefix(target, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes repository")
	}
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", fmt.Errorf("cannot resolve repository path: %w", err)
	}
	resolvedTarget, err := resolveExistingSymlinks(target)
	if err != nil {
		return "", err
	}
	if resolvedTarget != resolvedBase && !strings.HasPrefix(resolvedTarget, resolvedBase+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escapes repository")
	}
	return target, nil
}

// resolveExistingSymlinks resolves symlinks in target, walking up to the
// nearest existing ancestor when target itself does not exist yet (e.g. a
// working-tree path git still operates on by name, such as a deleted file).
// This closes the gap where a symlink inside the repo points outside it:
// os.Stat/os.ReadFile/os.ReadDir follow symlinks, so a text-only prefix
// check on the unresolved path is not enough.
func resolveExistingSymlinks(target string) (string, error) {
	suffix := ""
	dir := target
	for {
		resolved, err := filepath.EvalSymlinks(dir)
		if err == nil {
			if suffix == "" {
				return resolved, nil
			}
			return filepath.Join(resolved, suffix), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", err
		}
		suffix = filepath.Join(filepath.Base(dir), suffix)
		dir = parent
	}
}

// RepoFiles lists a directory inside a repository (directories first).
func (a *App) RepoFiles(repo, rel string) []RepoEntry {
	target, err := repoSubPath(repo, rel)
	if err != nil {
		return nil
	}
	dirEntries, err := os.ReadDir(target)
	if err != nil {
		return nil
	}
	var entries []RepoEntry
	for _, entry := range dirEntries {
		if entry.Name() == ".git" {
			continue
		}
		item := RepoEntry{Name: entry.Name(), Dir: entry.IsDir()}
		if info, err := entry.Info(); err == nil && !entry.IsDir() {
			item.Size = info.Size()
		}
		entries = append(entries, item)
		if len(entries) >= 500 {
			break
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir
		}
		return entries[i].Name < entries[j].Name
	})
	return entries
}

// RepoFile returns the content of a text file inside a repository.
func (a *App) RepoFile(repo, rel string) string {
	target, err := repoSubPath(repo, rel)
	if err != nil {
		return err.Error()
	}
	info, err := os.Stat(target)
	if err != nil {
		return "Could not read file: " + err.Error()
	}
	if info.Size() > 512*1024 {
		return fmt.Sprintf("File is too large to preview (%d KB).", info.Size()/1024)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "Could not read file: " + err.Error()
	}
	if isBinaryContent(data) {
		return fmt.Sprintf("Binary file (%d bytes).", len(data))
	}
	const maxPreview = 100 * 1024
	if len(data) > maxPreview {
		return string(data[:maxPreview]) + "\n\n… truncated for preview …"
	}
	return string(data)
}

// ========== Commit inspection ==========

var commitHashPattern = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// CommitFile is one file touched by a commit.
type CommitFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// CommitFiles lists the files changed by a commit with add/delete counts.
func (a *App) CommitFiles(repo, hash string) []CommitFile {
	if !commitHashPattern.MatchString(hash) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// --diff-merges=first-parent: merge commits show their changes too
	// (git show prints nothing for merges by default).
	statusOut, err := exec.CommandContext(ctx, "git", "-C", repo, "show", "--name-status", "--format=", "--diff-merges=first-parent", hash).Output()
	if err != nil {
		return nil
	}
	numstatOut, _ := exec.CommandContext(ctx, "git", "-C", repo, "show", "--numstat", "--format=", "--diff-merges=first-parent", hash).Output()
	counts := map[string][2]int{}
	for _, line := range strings.Split(string(numstatOut), "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		var adds, dels int
		fmt.Sscanf(parts[0], "%d", &adds)
		fmt.Sscanf(parts[1], "%d", &dels)
		counts[parts[2]] = [2]int{adds, dels}
	}
	var files []CommitFile
	for _, line := range strings.Split(strings.TrimSpace(string(statusOut)), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) < 2 || len(parts[0]) == 0 {
			continue
		}
		// Renames come as "R100\told\tnew"; show the new path.
		path := parts[len(parts)-1]
		status := string(parts[0][0])
		count := counts[path]
		files = append(files, CommitFile{Path: path, Status: status, Additions: count[0], Deletions: count[1]})
	}
	return files
}

// CommitDiff returns the diff a commit applied to one file.
func (a *App) CommitDiff(repo, hash, path string) string {
	if !commitHashPattern.MatchString(hash) {
		return "Invalid commit hash."
	}
	if _, err := repoSubPath(repo, path); err != nil {
		return err.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "show", "--format=", "--diff-merges=first-parent", hash, "--", path).Output()
	if err != nil {
		return "Could not load diff."
	}
	text := strings.TrimSpace(string(output))
	if text == "" {
		return "No changes to show."
	}
	if len(text) > 200*1024 {
		text = text[:200*1024] + "\n\n… truncated …"
	}
	return text
}

// ========== Working tree (source control) ==========

func isBinaryContent(data []byte) bool {
	limit := len(data)
	if limit > 8000 {
		limit = 8000
	}
	for _, b := range data[:limit] {
		if b == 0 {
			return true
		}
	}
	return false
}
