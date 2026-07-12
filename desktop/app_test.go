package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// A raw TCP service (like a database) must be reported reachable, not down,
// even though it fails the HTTP probe.
func TestCheckHTTPFallsBackToTCP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	port := listener.Addr().(*net.TCPAddr).Port
	result := healthChecker.Check(ctx, fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if result.State != "reachable" {
		t.Errorf("expected reachable for open non-HTTP port, got %s (%s)", result.State, result.Message)
	}
}

// The first job scan must only establish a baseline: every job already
// running before the app started should not be reported as newly
// discovered.
func TestDiffJobEventsBaselineEmitsNothing(t *testing.T) {
	a := &App{}
	a.diffJobEvents([]Job{{ID: "cron:1", Name: "cleanup", Source: "cron"}})
	if got := len(a.RecentEvents(0)); got != 0 {
		t.Fatalf("expected no events on baseline scan, got %d", got)
	}
}

func TestDiffJobEventsDiscoveredAndExited(t *testing.T) {
	a := &App{}
	a.diffJobEvents([]Job{{ID: "cron:1", Name: "cleanup", Source: "cron"}})

	a.diffJobEvents([]Job{
		{ID: "cron:1", Name: "cleanup", Source: "cron"},
		{ID: "docker-job:abc", Name: "queue-worker", Source: "docker"},
	})
	events := a.RecentEvents(0)
	if len(events) != 1 || events[0].Kind != "job_discovered" || events[0].Name != "queue-worker" {
		t.Fatalf("expected one job_discovered event for queue-worker, got %+v", events)
	}

	a.diffJobEvents([]Job{{ID: "cron:1", Name: "cleanup", Source: "cron"}})
	events = a.RecentEvents(0)
	if len(events) != 2 || events[0].Kind != "job_exited" || events[0].Name != "queue-worker" {
		t.Fatalf("expected job_exited event for queue-worker, got %+v", events)
	}
}

// Same baseline-gating for the port-ownership diff: the first scan must not
// report every already-listening port as a change.
func TestDiffPortEventsBaselineEmitsNothing(t *testing.T) {
	a := &App{}
	a.diffPortEvents([]PortUsage{{Port: 8080, Process: "node"}})
	if got := len(a.RecentEvents(0)); got != 0 {
		t.Fatalf("expected no events on baseline scan, got %d", got)
	}
}

func TestDiffPortEventsOwnerChanged(t *testing.T) {
	a := &App{}
	a.diffPortEvents([]PortUsage{{Port: 8080, Process: "node"}})
	a.diffPortEvents([]PortUsage{{Port: 8080, Process: "python"}})
	events := a.RecentEvents(0)
	if len(events) != 1 || events[0].Kind != "port_changed" {
		t.Fatalf("expected one port_changed event, got %+v", events)
	}
}

// Health events follow the same pattern: the first CheckHealth call for a
// URL must not be reported as a "change", and repeating the same state must
// not emit a duplicate event.
func TestRecordHealthSampleEmitsOnlyOnChange(t *testing.T) {
	a := &App{}
	a.recordHealthSample("http://localhost:8080/health", HealthStatus{Name: "api", State: "healthy"})
	if got := len(a.RecentEvents(0)); got != 0 {
		t.Fatalf("expected no event on first sample, got %d", got)
	}

	a.recordHealthSample("http://localhost:8080/health", HealthStatus{Name: "api", State: "healthy"})
	if got := len(a.RecentEvents(0)); got != 0 {
		t.Fatalf("expected no event when state is unchanged, got %d", got)
	}

	a.recordHealthSample("http://localhost:8080/health", HealthStatus{Name: "api", State: "down"})
	events := a.RecentEvents(0)
	if len(events) != 1 || events[0].Kind != "health_changed" {
		t.Fatalf("expected one health_changed event, got %+v", events)
	}
}

func TestOwnerRepoFromRemoteURL(t *testing.T) {
	cases := map[string]string{
		"https://github.com/owner/name.git":       "owner/name",
		"git@github.com:owner/name.git":           "owner/name",
		"git@ngocthanh:ngocthanh06/longbrain.git": "ngocthanh06/longbrain",
		"ssh://git@github.com/owner/name":         "owner/name",
		"":                                        "",
		"not-a-remote":                            "",
	}
	for remote, want := range cases {
		if got := ownerRepoFromRemoteURL(remote); got != want {
			t.Errorf("ownerRepoFromRemoteURL(%q) = %q, want %q", remote, got, want)
		}
	}
}

func TestParseDockerTopProcesses(t *testing.T) {
	output := "PID                 USER                TIME                COMMAND\n" +
		"1511772             root                3:35                {uvicorn} /usr/local/bin/python3.11 /usr/local/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000\n" +
		"1511800             root                0:12                node crawler.js\n"
	processes := parseDockerTopProcesses(output)
	if len(processes) != 2 {
		t.Fatalf("expected 2 processes, got %v", processes)
	}
	if processes[1] != "node crawler.js" {
		t.Errorf("expected command column only, got %q", processes[1])
	}
	if parseDockerTopProcesses("") != nil {
		t.Errorf("empty docker top output must return nil")
	}
	if parseDockerTopProcesses("PID USER TIME COMMAND\n") != nil {
		t.Errorf("header-only docker top output must return nil")
	}
}

// Real macOS system services (com.apple.*) must never be treated as a
// developer's background job — their labels contain generic keywords like
// "worker" (e.g. com.apple.mdworker.shared.<churning-id>) and would
// otherwise flood the job list and the Activity timeline every scan.
func TestLooksRelevantJobExcludesAppleSystemServices(t *testing.T) {
	cases := map[string]bool{
		"com.apple.mdworker.shared.06000000-0300-0000-0000-000000000000": false,
		"com.apple.cron.daily":       false,
		"com.mycompany.queue-worker": true,
		"com.laravel.horizon":        true,
		"com.apple.finder":           false,
	}
	for label, want := range cases {
		if got := looksRelevantJob(label); got != want {
			t.Errorf("looksRelevantJob(%q) = %v, want %v", label, got, want)
		}
	}
}

func TestLooksLikeDockerWorkload(t *testing.T) {
	cases := map[string]bool{
		"hermes-agent node crawler.js":  true,
		"docs-scraper python scrape.py": true,
		"postgres:16 postgres":          false,
		"nginx nginx -g daemon off;":    false,
	}
	for haystack, want := range cases {
		if got := looksLikeDockerWorkload(haystack); got != want {
			t.Errorf("looksLikeDockerWorkload(%q) = %v, want %v", haystack, got, want)
		}
	}
}

// GitChanges must classify staged, unstaged, untracked and partially staged
// files against a real repository.
func TestGitChanges(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	if err := os.WriteFile(repo+"/tracked.txt", []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "tracked.txt")
	run("commit", "-m", "init")

	// Modify tracked file, stage it, then modify again → partially staged.
	os.WriteFile(repo+"/tracked.txt", []byte("two\n"), 0o644)
	run("add", "tracked.txt")
	os.WriteFile(repo+"/tracked.txt", []byte("three\n"), 0o644)
	// New untracked file.
	os.WriteFile(repo+"/new file.txt", []byte("hi\n"), 0o644)

	app := &App{}
	changes := app.GitChanges(repo)

	var staged, unstaged, untracked int
	for _, c := range changes {
		switch {
		case c.Status == "?":
			untracked++
		case c.Staged:
			staged++
		default:
			unstaged++
		}
	}
	if staged != 1 || unstaged != 1 || untracked != 1 {
		t.Errorf("expected 1 staged / 1 unstaged / 1 untracked, got %d/%d/%d (%v)", staged, unstaged, untracked, changes)
	}
}

// Stage → diff → commit → resolve must work end-to-end on a real repository.
func TestWorkingTreeOperations(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	os.WriteFile(repo+"/a.txt", []byte("base\n"), 0o644)
	run("add", "a.txt")
	run("commit", "-m", "init")

	app := &App{}

	// Stage a modification, check diff, unstage, restage, commit.
	os.WriteFile(repo+"/a.txt", []byte("changed\n"), 0o644)
	if err := app.StageFile(repo, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if diff, err := app.GitDiff(repo, "a.txt", true); err != nil {
		t.Fatal(err)
	} else if !contains(diff, "+changed") {
		t.Errorf("staged diff should contain +changed, got: %s", diff)
	}
	if err := app.UnstageFile(repo, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if diff, err := app.GitDiff(repo, "a.txt", false); err != nil {
		t.Fatal(err)
	} else if !contains(diff, "+changed") {
		t.Errorf("unstaged diff should contain +changed, got: %s", diff)
	}
	if err := app.StageFile(repo, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if err := app.CommitChanges(repo, "update a"); err != nil {
		t.Fatal(err)
	}
	if changes := app.GitChanges(repo); len(changes) != 0 {
		t.Errorf("working tree should be clean after commit, got %v", changes)
	}

	// Create a merge conflict and resolve it with "theirs".
	run("switch", "-c", "feature")
	os.WriteFile(repo+"/a.txt", []byte("feature\n"), 0o644)
	run("commit", "-am", "feature change")
	run("switch", "main")
	os.WriteFile(repo+"/a.txt", []byte("main\n"), 0o644)
	run("commit", "-am", "main change")
	// Merge fails with a conflict; that is expected.
	exec.Command("git", "-C", repo, "merge", "feature").Run()

	changes := app.GitChanges(repo)
	if len(changes) != 1 || !changes[0].Conflict {
		t.Fatalf("expected one conflicted file, got %v", changes)
	}
	if err := app.ResolveConflict(repo, "a.txt", "theirs"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(repo + "/a.txt")
	if string(data) != "feature\n" {
		t.Errorf("expected theirs content, got %q", data)
	}
	changes = app.GitChanges(repo)
	if len(changes) != 1 || !changes[0].Staged {
		t.Errorf("resolved file should be staged, got %v", changes)
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

// CommitFiles/CommitDiff must report the files and diff of a commit.
func TestCommitInspection(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	os.WriteFile(repo+"/a.txt", []byte("one\n"), 0o644)
	run("add", "a.txt")
	run("commit", "-m", "init")
	os.WriteFile(repo+"/a.txt", []byte("one\ntwo\n"), 0o644)
	os.WriteFile(repo+"/b.txt", []byte("new\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "second")

	hashOut, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.TrimSpace(string(hashOut))

	app := &App{}
	files := app.CommitFiles(repo, hash)
	if len(files) != 2 {
		t.Fatalf("expected 2 files, got %v", files)
	}
	byPath := map[string]CommitFile{}
	for _, f := range files {
		byPath[f.Path] = f
	}
	if byPath["a.txt"].Status != "M" || byPath["a.txt"].Additions != 1 {
		t.Errorf("a.txt should be M with 1 addition, got %+v", byPath["a.txt"])
	}
	if byPath["b.txt"].Status != "A" {
		t.Errorf("b.txt should be A, got %+v", byPath["b.txt"])
	}
	if diff := app.CommitDiff(repo, hash, "a.txt"); !strings.Contains(diff, "+two") {
		t.Errorf("diff should contain +two, got: %s", diff)
	}
	if app.CommitFiles(repo, "not-a-hash") != nil {
		t.Errorf("invalid hash must return nil")
	}
}

// Regression: a non-current branch that sorts first must not vanish from the
// list (TrimSpace used to eat its leading marker).
func TestRepoBranchesKeepsFirstBranch(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	os.WriteFile(repo+"/a.txt", []byte("x\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "init")
	run("branch", "dev") // sorts before main

	app := &App{}
	// On main: dev is the first, non-current line.
	names := map[string]bool{}
	for _, b := range app.RepoBranches(repo) {
		names[b.Name] = true
	}
	if !names["dev"] || !names["main"] {
		t.Fatalf("expected both dev and main, got %v", names)
	}
	// Switch to dev, then main must still be listed.
	if err := app.SwitchBranch(repo, "dev"); err != nil {
		t.Fatal(err)
	}
	branches := app.RepoBranches(repo)
	names = map[string]bool{}
	current := ""
	for _, b := range branches {
		names[b.Name] = true
		if b.Current {
			current = b.Name
		}
	}
	if !names["dev"] || !names["main"] || current != "dev" {
		t.Fatalf("after switch expected dev(current)+main, got %v current=%s", names, current)
	}
}

// RepoGraph must return parents and refs across all branches.
func TestRepoGraph(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	os.WriteFile(repo+"/a.txt", []byte("1\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "c1")
	run("switch", "-c", "feature")
	os.WriteFile(repo+"/b.txt", []byte("2\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "c2")
	run("switch", "main")
	os.WriteFile(repo+"/c.txt", []byte("3\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "c3")
	run("merge", "--no-edit", "feature")

	app := &App{}
	graph := app.RepoGraph(repo, 50)
	if len(graph) != 4 {
		t.Fatalf("expected 4 commits, got %d: %v", len(graph), graph)
	}
	merge := graph[0]
	if len(merge.Parents) != 2 {
		t.Errorf("merge commit should have 2 parents, got %v", merge.Parents)
	}
	if !merge.Head {
		t.Errorf("merge commit should be HEAD")
	}
	foundFeatureRef := false
	for _, c := range graph {
		for _, ref := range c.Refs {
			if ref == "feature" {
				foundFeatureRef = true
			}
		}
	}
	if !foundFeatureRef {
		t.Errorf("feature ref missing from graph: %v", graph)
	}
	root := graph[len(graph)-1]
	if len(root.Parents) != 0 {
		t.Errorf("root commit should have no parents, got %v", root.Parents)
	}
}

// Merge commits must list their files too (git show is empty by default).
func TestCommitFilesOnMergeCommit(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	os.WriteFile(repo+"/a.txt", []byte("1\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "c1")
	run("switch", "-c", "feature")
	os.WriteFile(repo+"/b.txt", []byte("2\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "c2")
	run("switch", "main")
	os.WriteFile(repo+"/c.txt", []byte("3\n"), 0o644)
	run("add", ".")
	run("commit", "-m", "c3")
	run("merge", "--no-edit", "feature")

	hashOut, _ := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	hash := strings.TrimSpace(string(hashOut))

	app := &App{}
	files := app.CommitFiles(repo, hash)
	if len(files) == 0 {
		t.Fatalf("merge commit must list changed files, got none")
	}
	found := false
	for _, f := range files {
		if f.Path == "b.txt" {
			found = true
		}
	}
	if !found {
		t.Errorf("merge (first-parent) should include b.txt, got %v", files)
	}
	if diff := app.CommitDiff(repo, hash, "b.txt"); !strings.Contains(diff, "+2") {
		t.Errorf("merge diff for b.txt should contain +2, got: %s", diff)
	}
}
