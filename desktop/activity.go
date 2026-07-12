package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

// Commit represents a git commit
type Commit struct {
	Hash        string `json:"hash"`
	Subject     string `json:"subject"`
	Author      string `json:"author"`
	AuthorEmail string `json:"author_email"`
	OccurredAt  string `json:"occurred_at"`
	RepoName    string `json:"repo_name"`
	RepoPath    string `json:"repo_path"`
}

// RepositoryActivity represents a discovered git repository included in activity.
type RepositoryActivity struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Path          string `json:"path"`
	Branch        string `json:"branch,omitempty"`
	CommitCount   int    `json:"commit_count"`
	ChangedFiles  int    `json:"changed_files"`
	StagedFiles   int    `json:"staged_files"`
	Ahead         int    `json:"ahead"`
	Behind        int    `json:"behind"`
	Ignored       bool   `json:"ignored"`
	EventTracking bool   `json:"event_tracking"`
	Identity      string `json:"identity,omitempty"`
}

// ActivitySummary represents git activity across repos
type ActivitySummary struct {
	Since          string               `json:"since"`
	Commits        []Commit             `json:"commits"`
	Events         []GitEvent           `json:"events"`
	Repositories   []RepositoryActivity `json:"repositories"`
	CommitCount    int                  `json:"commit_count"`
	EventCount     int                  `json:"event_count"`
	ActiveDays     int                  `json:"active_days"`
	CompletedTasks int                  `json:"completed_tasks"`
	OpenTasks      int                  `json:"open_tasks"`
	Unpushed       int                  `json:"unpushed"`
	Branch         string               `json:"branch,omitempty"`
	ChangedFiles   int                  `json:"changed_files"`
	StagedFiles    int                  `json:"staged_files"`
	Ahead          int                  `json:"ahead"`
	Behind         int                  `json:"behind"`
	MyName         string               `json:"my_name,omitempty"`
	MyEmail        string               `json:"my_email,omitempty"`
	Identities     []string             `json:"identities,omitempty"`
	MineOnly       bool                 `json:"mine_only"`
	Note           string               `json:"note,omitempty"`
	QualityScore   int                  `json:"quality_score"`
	FixCommits     int                  `json:"fix_commits"`
	FeatureCommits int                  `json:"feature_commits"`
	DocsCommits    int                  `json:"docs_commits"`
	ChoreCommits   int                  `json:"chore_commits"`
	MergeCommits   int                  `json:"merge_commits"`
}

// cachedRepoPaths walks the search roots at most once per TTL; discovering
// repositories is the slowest part of the activity scan.
func (a *App) cachedRepoPaths() []string {
	a.repoCacheMu.Lock()
	defer a.repoCacheMu.Unlock()
	if a.repoCache != nil && time.Since(a.repoCacheAt) < 5*time.Minute {
		return a.repoCache
	}
	var paths []string
	for _, root := range discovery.GitSearchRoots() {
		repos, _ := discovery.FindGitRepos(root, 5)
		paths = append(paths, repos...)
	}
	a.repoCache = paths
	a.repoCacheAt = time.Now()
	return paths
}

func (a *App) GetActivity() ActivitySummary {
	settings := loadUserSettings()
	myName, myEmail := getGlobalGitIdentity()

	summary := ActivitySummary{
		Since:    time.Now().AddDate(0, 0, -7).Format(time.RFC3339),
		MyName:   myName,
		MyEmail:  myEmail,
		MineOnly: settings.MineOnly,
	}

	var allCommits []Commit
	var fallbackCommits []Commit
	var repositories []RepositoryActivity
	totalAhead, totalBehind := 0, 0
	totalChanged, totalStaged := 0, 0
	var branches []string
	// Machines with several git accounts (global + per-repo/includeIf
	// configs) get every distinct identity listed, not just the global one.
	identitySet := map[string]bool{}
	if global := formatIdentity(myName, myEmail); global != "" {
		identitySet[global] = true
	}

	repoPaths := a.cachedRepoPaths()

	// Each repo needs ~6 git invocations; running repos sequentially made
	// the dashboard slow. Process them in parallel with a bounded pool and
	// merge results in scan order so output stays deterministic.
	type repoScan struct {
		activity   RepositoryActivity
		rawCommits []Commit
		commits    []Commit
		branch     string
	}
	results := make([]*repoScan, len(repoPaths))
	sem := make(chan struct{}, 16)
	var wg sync.WaitGroup
	for i, repo := range repoPaths {
		if settings.IgnoredRepos[repo] {
			results[i] = &repoScan{activity: RepositoryActivity{ID: repoID(repo), Name: filepath.Base(repo), Path: repo, Ignored: true, EventTracking: settings.EventRepos[repo]}}
			continue
		}
		wg.Add(1)
		go func(i int, repo string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			scan := &repoScan{}
			rawCommits, _ := getCommits(repo, time.Now().AddDate(0, 0, -7))
			scan.rawCommits = rawCommits
			commits := rawCommits
			// Each repo can commit under a different account: git config
			// resolved inside the repo (local overrides global) is the
			// identity that repo's commits should be matched against.
			repoName := gitConfigValue(repo, "user.name")
			repoEmail := gitConfigValue(repo, "user.email")
			if settings.MineOnly && (repoName != "" || repoEmail != "") {
				commits = filterMyCommits(commits, repoName, repoEmail)
			}
			scan.commits = commits

			ahead, behind, _ := getAheadBehind(repo)
			branch, _ := getBranch(repo)
			scan.branch = branch
			changed, staged, _ := getStatus(repo)

			scan.activity = RepositoryActivity{
				ID:            repoID(repo),
				Name:          filepath.Base(repo),
				Path:          repo,
				Branch:        branch,
				CommitCount:   len(commits),
				ChangedFiles:  changed,
				StagedFiles:   staged,
				Ahead:         ahead,
				Behind:        behind,
				EventTracking: settings.EventRepos[repo],
				Identity:      formatIdentity(repoName, repoEmail),
			}
			results[i] = scan
		}(i, repo)
	}
	wg.Wait()

	for _, scan := range results {
		if scan == nil {
			continue
		}
		repositories = append(repositories, scan.activity)
		if scan.activity.Ignored {
			continue
		}
		fallbackCommits = append(fallbackCommits, scan.rawCommits...)
		allCommits = append(allCommits, scan.commits...)
		if id := scan.activity.Identity; id != "" {
			identitySet[id] = true
		}
		totalAhead += scan.activity.Ahead
		totalBehind += scan.activity.Behind
		totalChanged += scan.activity.ChangedFiles
		totalStaged += scan.activity.StagedFiles
		if scan.branch != "" {
			branches = append(branches, scan.branch)
		}
	}

	sort.Slice(allCommits, func(i, j int) bool {
		return allCommits[i].OccurredAt > allCommits[j].OccurredAt
	})

	if len(allCommits) == 0 && settings.MineOnly && len(fallbackCommits) > 0 {
		allCommits = fallbackCommits
		summary.MineOnly = false
		summary.Note = "No commits matched your current Git identity, so Thaloca is showing all discovered commits. Update git config or toggle My commits only."
		sort.Slice(allCommits, func(i, j int) bool {
			return allCommits[i].OccurredAt > allCommits[j].OccurredAt
		})
	}

	for id := range identitySet {
		summary.Identities = append(summary.Identities, id)
	}
	sort.Strings(summary.Identities)

	summary.Commits = allCommits
	summary.Events = filterGitEvents(readGitEvents(), settings)
	summary.Repositories = repositories
	summary.CommitCount = len(allCommits)
	summary.EventCount = len(summary.Events)
	summary.ActiveDays = countActiveDays(allCommits)
	summary.FixCommits, summary.FeatureCommits, summary.DocsCommits, summary.ChoreCommits, summary.MergeCommits = classifyCommits(allCommits)
	summary.QualityScore = scoreActivity(summary)
	summary.Ahead = totalAhead
	summary.Behind = totalBehind
	summary.ChangedFiles = totalChanged
	summary.StagedFiles = totalStaged
	if len(branches) > 0 {
		summary.Branch = branches[0]
	}

	return summary
}

func (a *App) IgnoreRepository(path string) ActivitySummary {
	settings := loadUserSettings()
	if settings.IgnoredRepos == nil {
		settings.IgnoredRepos = map[string]bool{}
	}
	settings.IgnoredRepos[path] = true
	_ = saveUserSettings(settings)
	return a.GetActivity()
}

func (a *App) TrackRepository(path string) ActivitySummary {
	settings := loadUserSettings()
	delete(settings.IgnoredRepos, path)
	_ = saveUserSettings(settings)
	return a.GetActivity()
}

func (a *App) SetMineOnly(enabled bool) ActivitySummary {
	settings := loadUserSettings()
	settings.MineOnly = enabled
	_ = saveUserSettings(settings)
	return a.GetActivity()
}

func (a *App) EnableGitEvents(path string) ActivitySummary {
	settings := loadUserSettings()
	if settings.EventRepos == nil {
		settings.EventRepos = map[string]bool{}
	}
	if err := installGitEventHooks(path); err != nil {
		summary := a.GetActivity()
		summary.Note = "Could not enable events: " + err.Error()
		return summary
	}
	settings.EventRepos[path] = true
	_ = saveUserSettings(settings)
	return a.GetActivity()
}

func (a *App) DisableGitEvents(path string) ActivitySummary {
	settings := loadUserSettings()
	delete(settings.EventRepos, path)
	_ = removeGitEventHooks(path)
	_ = saveUserSettings(settings)
	return a.GetActivity()
}

func getCommits(repo string, since time.Time) ([]Commit, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", repo, "log",
		"--since="+since.Format("2006-01-02"),
		"--date=iso-strict",
		"--pretty=format:%H%x1f%s%x1f%an%x1f%ae%x1f%aI",
		"--all",
	)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return parseGitLog(string(output), repo), nil
}

func parseGitLog(output, repo string) []Commit {
	var commits []Commit
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\x1f")
		if len(parts) != 5 {
			continue
		}
		commits = append(commits, Commit{
			Hash:        shortCommitHash(parts[0]),
			Subject:     parts[1],
			Author:      parts[2],
			AuthorEmail: parts[3],
			OccurredAt:  parts[4],
			RepoName:    filepath.Base(repo),
			RepoPath:    repo,
		})
	}
	return commits
}

func getGlobalGitIdentity() (string, string) {
	name := strings.TrimSpace(gitConfigValue("", "user.name"))
	email := strings.TrimSpace(gitConfigValue("", "user.email"))
	return name, email
}

func gitConfigValue(repo, key string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	args := []string{"config", "--get", key}
	if repo != "" {
		args = []string{"-C", repo, "config", "--get", key}
	}
	output, err := exec.CommandContext(ctx, "git", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func filterMyCommits(commits []Commit, name, email string) []Commit {
	var filtered []Commit
	name = strings.ToLower(strings.TrimSpace(name))
	email = strings.ToLower(strings.TrimSpace(email))
	for _, commit := range commits {
		author := strings.ToLower(strings.TrimSpace(commit.Author))
		authorEmail := strings.ToLower(strings.TrimSpace(commit.AuthorEmail))
		if (email != "" && authorEmail == email) || (name != "" && author == name) {
			filtered = append(filtered, commit)
		}
	}
	return filtered
}

func formatIdentity(name, email string) string {
	name = strings.TrimSpace(name)
	email = strings.TrimSpace(email)
	switch {
	case name != "" && email != "":
		return name + " <" + email + ">"
	case name != "":
		return name
	default:
		return email
	}
}

func repoID(path string) string {
	return strings.ReplaceAll(path, string(os.PathSeparator), "-")
}

func getAheadBehind(repo string) (int, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", repo, "rev-list", "--left-right", "--count", "HEAD...@{u}")
	output, err := cmd.Output()
	if err != nil {
		return 0, 0, nil
	}
	var ahead, behind int
	fmt.Sscanf(string(output), "%d\t%d", &ahead, &behind)
	return ahead, behind, nil
}

func getBranch(repo string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", repo, "branch", "--show-current")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func getStatus(repo string) (int, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", repo, "status", "--porcelain")
	output, err := cmd.Output()
	if err != nil {
		return 0, 0, err
	}
	changed, staged := 0, 0
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		if len(line) >= 2 {
			if line[1] != ' ' {
				changed++
			}
			if line[0] != ' ' && line[0] != '?' {
				staged++
			}
		}
	}
	return changed, staged, nil
}

func countActiveDays(commits []Commit) int {
	days := make(map[string]bool)
	for _, c := range commits {
		if len(c.OccurredAt) >= 10 {
			days[c.OccurredAt[:10]] = true
		}
	}
	return len(days)
}

func classifyCommits(commits []Commit) (fixes, features, docs, chores, merges int) {
	for _, commit := range commits {
		subject := strings.ToLower(strings.TrimSpace(commit.Subject))
		switch {
		case strings.HasPrefix(subject, "merge "):
			merges++
		case strings.HasPrefix(subject, "fix") || strings.Contains(subject, "bug") || strings.Contains(subject, "hotfix"):
			fixes++
		case strings.HasPrefix(subject, "feat") || strings.Contains(subject, "feature"):
			features++
		case strings.HasPrefix(subject, "docs") || strings.Contains(subject, "readme"):
			docs++
		case strings.HasPrefix(subject, "chore") || strings.HasPrefix(subject, "refactor") || strings.HasPrefix(subject, "test"):
			chores++
		}
	}
	return fixes, features, docs, chores, merges
}

func scoreActivity(summary ActivitySummary) int {
	if summary.CommitCount == 0 {
		return 0
	}
	score := 55
	score += minInt(summary.ActiveDays*5, 25)
	score += minInt(summary.FeatureCommits*3, 12)
	score += minInt(summary.FixCommits*2, 12)
	score += minInt(summary.DocsCommits*2, 8)
	if summary.ChangedFiles > 50 {
		score -= 8
	}
	if summary.MergeCommits > summary.CommitCount/2 {
		score -= 8
	}
	if score < 0 {
		return 0
	}
	if score > 100 {
		return 100
	}
	return score
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ========== Repository detail (local git) ==========

// RepoBranch is a local branch of a repository.
