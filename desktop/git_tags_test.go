package main

import (
	"os"
	"os/exec"
	"testing"
)

func initTagTestRepo(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test")
	if err := os.WriteFile(repo+"/README.md", []byte("test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "initial")
	return repo
}

func TestRepoTagsCreateListCheckoutAndDelete(t *testing.T) {
	repo := initTagTestRepo(t)
	app := &App{}
	if err := app.CreateTag(repo, "v1.2.3", "HEAD", "Release 1.2.3"); err != nil {
		t.Fatalf("CreateTag: %v", err)
	}
	tags := app.RepoTags(repo)
	if len(tags) != 1 || tags[0].Name != "v1.2.3" || !tags[0].Annotated || tags[0].Subject != "Release 1.2.3" {
		t.Fatalf("unexpected tags: %#v", tags)
	}
	if err := app.CheckoutTag(repo, "v1.2.3"); err != nil {
		t.Fatalf("CheckoutTag: %v", err)
	}
	if out, err := exec.Command("git", "-C", repo, "symbolic-ref", "-q", "HEAD").Output(); err == nil || len(out) != 0 {
		t.Fatalf("expected detached HEAD, got %q, err=%v", out, err)
	}
	if err := app.DeleteTag(repo, "v1.2.3"); err != nil {
		t.Fatalf("DeleteTag: %v", err)
	}
	if tags := app.RepoTags(repo); len(tags) != 0 {
		t.Fatalf("expected no tags after delete, got %#v", tags)
	}
}

func TestCreateTagRejectsInvalidInput(t *testing.T) {
	app := &App{}
	if err := app.CreateTag(t.TempDir(), "bad tag", "HEAD", "release"); err == nil {
		t.Fatal("expected invalid tag name to be rejected")
	}
	if err := app.CreateTag(t.TempDir(), "v1.0.0", "HEAD", ""); err == nil {
		t.Fatal("expected empty tag message to be rejected")
	}
}
