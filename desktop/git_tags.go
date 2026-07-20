package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// RepoTag is a local Git tag. Release tags are created annotated so their
// message, creator and creation time remain part of the repository history.
type RepoTag struct {
	Name       string `json:"name"`
	CommitHash string `json:"commit_hash"`
	Subject    string `json:"subject"`
	Creator    string `json:"creator"`
	CreatedAt  string `json:"created_at"`
	Annotated  bool   `json:"annotated"`
}

func validTagName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("tag name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "git", "check-ref-format", "refs/tags/"+name).Run(); err != nil {
		return fmt.Errorf("invalid tag name: %s", name)
	}
	return nil
}

// RepoTags lists local tags newest first. For annotated tags, *objectname is
// the tagged commit; for lightweight tags objectname itself is the commit.
func (a *App) RepoTags(repo string) []RepoTag {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", repo, "for-each-ref",
		"--sort=-creatordate",
		"--format=%(refname:short)%00%(objecttype)%00%(*objectname)%00%(objectname)%00%(subject)%00%(creator)%00%(creatordate:iso-strict)",
		"refs/tags").Output()
	if err != nil {
		return nil
	}
	var tags []RepoTag
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		parts := strings.Split(line, "\x00")
		if len(parts) != 7 || parts[0] == "" {
			continue
		}
		annotated := parts[1] == "tag"
		commit := parts[3]
		if annotated && parts[2] != "" {
			commit = parts[2]
		}
		tags = append(tags, RepoTag{
			Name: parts[0], CommitHash: shortCommitHash(commit), Subject: parts[4],
			Creator: parts[5], CreatedAt: parts[6], Annotated: annotated,
		})
	}
	return tags
}

func (a *App) CreateTag(repo, name, target, message string) error {
	if err := validTagName(name); err != nil {
		return err
	}
	name, target, message = strings.TrimSpace(name), strings.TrimSpace(target), strings.TrimSpace(message)
	if target == "" {
		target = "HEAD"
	}
	if message == "" {
		return fmt.Errorf("tag message is empty")
	}
	return runGitCommand(repo, 10*time.Second, "tag", "-a", "-m", message, "--", name, target)
}

func (a *App) CheckoutTag(repo, name string) error {
	if err := validTagName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 10*time.Second, "switch", "--detach", "--", strings.TrimSpace(name))
}

func (a *App) PushTag(repo, name string) error {
	if err := validTagName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 60*time.Second, "push", "origin", "refs/tags/"+strings.TrimSpace(name))
}

func (a *App) DeleteTag(repo, name string) error {
	if err := validTagName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 10*time.Second, "tag", "-d", "--", strings.TrimSpace(name))
}

func (a *App) DeleteRemoteTag(repo, name string) error {
	if err := validTagName(name); err != nil {
		return err
	}
	return runGitCommand(repo, 60*time.Second, "push", "origin", ":refs/tags/"+strings.TrimSpace(name))
}
