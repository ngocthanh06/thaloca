package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type GitHubStatus struct {
	Configured    bool   `json:"configured"`    // OAuth client id saved
	Authenticated bool   `json:"authenticated"` // token stored in Keychain
	Login         string `json:"login,omitempty"`
	Repo          string `json:"repo,omitempty"`
	Message       string `json:"message,omitempty"`
	// Source is where the active token came from: "gh" (the gh CLI's
	// currently active account), "keychain" (Thaloca's own saved
	// OAuth/PAT login), or "git-credential". The frontend uses this to hide
	// "Logout" when it would have no effect (gh always takes priority).
	Source string `json:"source,omitempty"`
}

// --- Local config (~/.thaloca/config.json) ---

type appConfig struct {
	GitHubClientID string `json:"github_client_id,omitempty"`
}

func configFilePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "config.json"), nil
}

func loadAppConfig() appConfig {
	var cfg appConfig
	path, err := configFilePath()
	if err != nil {
		return cfg
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg
}

func saveAppConfig(cfg appConfig) error {
	path, err := configFilePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(path, data, 0o600)
}

// --- Token storage in the macOS Keychain (security CLI, no dependency) ---

const keychainService = "thaloca-github"

func keychainSetToken(token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "security", "add-generic-password",
		"-U", "-s", keychainService, "-a", "thaloca", "-w", token).CombinedOutput()
	if err != nil {
		return fmt.Errorf("keychain: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func keychainToken() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "security", "find-generic-password",
		"-s", keychainService, "-a", "thaloca", "-w").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func keychainDeleteToken() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "security", "delete-generic-password",
		"-s", keychainService, "-a", "thaloca").Run()
}

// gitCredentialToken asks git's own credential helpers (osxkeychain, gh, …)
// for a stored github.com token — the same source git uses for HTTPS pushes.
// Only API-capable tokens (PAT/OAuth) are returned, never raw passwords.
func gitCredentialToken() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "credential", "fill")
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\n\n")
	// Never let credential helpers prompt; return empty instead.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/usr/bin/true")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(output), "\n") {
		password := strings.TrimPrefix(line, "password=")
		if password != line && (strings.HasPrefix(password, "gh") || strings.HasPrefix(password, "github_pat_")) {
			return password
		}
	}
	return ""
}

// ghCLIToken asks the gh CLI directly for its current auth token via
// `gh auth token`. This is more reliable than gitCredentialToken: git's
// credential resolution can return a cached, non-API credential from an
// unrelated helper (e.g. osxkeychain) before ever reaching gh's, even after
// `gh auth login` succeeds.
func ghCLIToken() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

// resolveGithubToken returns the best available API token together with
// where it came from. The gh CLI is checked first and takes priority
// whenever it is installed and logged in: gh already supports multiple
// GitHub accounts via `gh auth switch`, so deferring to it means Thaloca
// always reflects whichever account is currently active there, rather than
// a single account cached once into Thaloca's own Keychain entry (used as a
// fallback for users without gh). The source matters for the UI: "Logout"
// only clears Thaloca's own Keychain entry, so it has no effect while gh's
// token still takes priority.
func resolveGithubToken() (token string, source string) {
	if token := ghCLIToken(); token != "" {
		return token, "gh"
	}
	if token := keychainToken(); token != "" {
		return token, "keychain"
	}
	if token := gitCredentialToken(); token != "" {
		return token, "git-credential"
	}
	return "", ""
}

func githubToken() string {
	token, _ := resolveGithubToken()
	return token
}

// GitHubCLIInstalled reports whether the `gh` CLI is on PATH — used by the
// frontend to word the confirmation dialog correctly before calling
// InstallAndLoginGitHubCLI.
func (a *App) GitHubCLIInstalled() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

// GitHubCLIAccount is one account gh is currently logged into on
// github.com.
type GitHubCLIAccount struct {
	Login  string `json:"login"`
	Active bool   `json:"active"`
}

// GitHubCLIAccounts lists every github.com account currently logged into
// the gh CLI (gh supports being logged into several at once, switching
// which one is "active" via `gh auth switch`) — backs an in-app account
// switcher so the user doesn't have to run that in a terminal themselves.
func (a *App) GitHubCLIAccounts() ([]GitHubCLIAccount, error) {
	if _, err := exec.LookPath("gh"); err != nil {
		return nil, fmt.Errorf("gh CLI is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "auth", "status", "--hostname", "github.com", "--json", "hosts").Output()
	if err != nil {
		return nil, fmt.Errorf("gh auth status: %w", err)
	}
	var raw struct {
		Hosts map[string][]struct {
			Login  string `json:"login"`
			Active bool   `json:"active"`
		} `json:"hosts"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, err
	}
	accounts := []GitHubCLIAccount{}
	for _, acc := range raw.Hosts["github.com"] {
		accounts = append(accounts, GitHubCLIAccount{Login: acc.Login, Active: acc.Active})
	}
	return accounts, nil
}

// SwitchGitHubCLIAccount makes the given login gh's active account for
// github.com — every subsequent GitHub API call Thaloca makes (via
// resolveGithubToken -> ghCLIToken) uses whichever account is active, so
// this takes effect immediately without restarting the app.
func (a *App) SwitchGitHubCLIAccount(login string) error {
	login = strings.TrimSpace(login)
	if login == "" {
		return fmt.Errorf("account is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "gh", "auth", "switch", "--hostname", "github.com", "--user", login).CombinedOutput()
	if err != nil {
		return fmt.Errorf("gh auth switch: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// InstallAndLoginGitHubCLI opens Terminal.app to install the GitHub CLI via
// Homebrew (if missing) and run `gh auth login`. The frontend must confirm
// with the user before calling this — it runs a real install command in a
// visible terminal so the user watches the output, rather than the app
// silently installing software. Once `gh auth login` completes, its token
// is already reachable through gitCredentialToken() (git's own credential
// helper), so no separate storage step is needed here.
func (a *App) InstallAndLoginGitHubCLI() error {
	if _, err := exec.LookPath("brew"); err != nil {
		return fmt.Errorf("Homebrew is not installed. Install it from https://brew.sh, then try again")
	}
	command := "gh auth login"
	if _, err := exec.LookPath("gh"); err != nil {
		command = "brew install gh && " + command
	}
	return openInTerminal(command)
}

// --- OAuth device flow ---

// GitHubClientID returns the saved OAuth app client id.
func (a *App) GitHubClientID() string {
	return loadAppConfig().GitHubClientID
}

// SetGitHubClientID stores the OAuth app client id. It identifies the app,
// not the user, and is public by design for the device flow.
func (a *App) SetGitHubClientID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("client id is empty")
	}
	cfg := loadAppConfig()
	cfg.GitHubClientID = id
	return saveAppConfig(cfg)
}

// DeviceCode is what the user needs to finish logging in via the browser.
type DeviceCode struct {
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expires_in"`
}

func githubForm(urlStr string, form url.Values, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, urlStr, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("github request failed (%s): %s", resp.Status, strings.TrimSpace(string(data)))
	}
	return json.Unmarshal(data, out)
}

// GitHubDeviceStart begins the OAuth device flow and opens the verification
// page in the browser; the returned user code must be typed there.
func (a *App) GitHubDeviceStart() (DeviceCode, error) {
	clientID := loadAppConfig().GitHubClientID
	if clientID == "" {
		return DeviceCode{}, fmt.Errorf("no GitHub OAuth client id configured yet")
	}
	var raw struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		Interval        int    `json:"interval"`
		ExpiresIn       int    `json:"expires_in"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}
	form := url.Values{"client_id": {clientID}, "scope": {"repo read:user"}}
	if err := githubForm("https://github.com/login/device/code", form, &raw); err != nil {
		return DeviceCode{}, err
	}
	if raw.Error != "" || raw.DeviceCode == "" {
		message := raw.ErrorDesc
		if message == "" {
			message = raw.Error
		}
		if message == "" {
			message = "GitHub returned no device code — check the client id and that Device Flow is enabled for the OAuth app"
		}
		return DeviceCode{}, fmt.Errorf("%s", message)
	}
	a.ghMu.Lock()
	a.ghDeviceCode = raw.DeviceCode
	a.ghDeviceExpiresAt = time.Now().Add(time.Duration(raw.ExpiresIn) * time.Second)
	a.ghMu.Unlock()
	if raw.Interval < 5 {
		raw.Interval = 5
	}
	wailsruntime.BrowserOpenURL(a.ctx, raw.VerificationURI)
	return DeviceCode{UserCode: raw.UserCode, VerificationURI: raw.VerificationURI, Interval: raw.Interval, ExpiresIn: raw.ExpiresIn}, nil
}

// GitHubDevicePoll checks once whether the user finished authorizing in the
// browser. Returns "ok" once the token is stored, "pending" while waiting.
func (a *App) GitHubDevicePoll() (string, error) {
	a.ghMu.Lock()
	deviceCode := a.ghDeviceCode
	expiresAt := a.ghDeviceExpiresAt
	a.ghMu.Unlock()
	if deviceCode == "" {
		return "", fmt.Errorf("no login in progress")
	}
	if !expiresAt.IsZero() && time.Now().After(expiresAt) {
		a.ghMu.Lock()
		a.ghDeviceCode = ""
		a.ghMu.Unlock()
		return "", fmt.Errorf("device code expired, please try logging in again")
	}
	var raw struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	form := url.Values{
		"client_id":   {loadAppConfig().GitHubClientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	if err := githubForm("https://github.com/login/oauth/access_token", form, &raw); err != nil {
		return "", err
	}
	switch {
	case raw.AccessToken != "":
		a.ghMu.Lock()
		a.ghDeviceCode = ""
		a.ghMu.Unlock()
		if err := keychainSetToken(raw.AccessToken); err != nil {
			return "", err
		}
		return "ok", nil
	case raw.Error == "authorization_pending", raw.Error == "slow_down":
		return "pending", nil
	default:
		a.ghMu.Lock()
		a.ghDeviceCode = ""
		a.ghMu.Unlock()
		message := raw.ErrorDesc
		if message == "" {
			message = raw.Error
		}
		return "", fmt.Errorf("%s", message)
	}
}

// GitHubLogout removes the stored token from the Keychain.
func (a *App) GitHubLogout() {
	keychainDeleteToken()
}

// GitHubSetToken stores a pasted personal access token after validating it
// against the API — the quickest path when the user already has a PAT.
func (a *App) GitHubSetToken(token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("token is empty")
	}
	if _, err := githubAPI(http.MethodGet, "/user", token, "", nil); err != nil {
		return fmt.Errorf("GitHub rejected this token: %s", err)
	}
	return keychainSetToken(token)
}

// --- REST / GraphQL client ---

func githubAPI(method, path, token, accept string, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if accept == "" {
		accept = "application/vnd.github+json"
	}
	req.Header.Set("Accept", accept)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		var ghErr struct {
			Message string `json:"message"`
			Errors  []struct {
				Resource string `json:"resource"`
				Field    string `json:"field"`
				Code     string `json:"code"`
				Message  string `json:"message"`
			} `json:"errors"`
		}
		_ = json.Unmarshal(data, &ghErr)
		if ghErr.Message == "" {
			ghErr.Message = resp.Status
		}
		// A 422 "Validation Failed" carries the actual reason (e.g. "A pull
		// request already exists for foo:bar", "No commits between main and
		// feature-x") in `errors[]`, not in the generic top-level `message` —
		// without this the user only ever sees "Validation Failed" and has
		// no way to tell what actually went wrong.
		var details []string
		for _, e := range ghErr.Errors {
			switch {
			case e.Message != "":
				details = append(details, e.Message)
			case e.Field != "":
				details = append(details, fmt.Sprintf("%s %s: %s", e.Resource, e.Field, e.Code))
			}
		}
		if len(details) > 0 {
			return nil, fmt.Errorf("GitHub API: %s: %s", ghErr.Message, strings.Join(details, "; "))
		}
		return nil, fmt.Errorf("GitHub API: %s", ghErr.Message)
	}
	return data, nil
}

type PullRequest struct {
	Number         int      `json:"number"`
	Title          string   `json:"title"`
	Author         string   `json:"author"`
	HeadRef        string   `json:"head_ref"`
	BaseRef        string   `json:"base_ref"`
	State          string   `json:"state"`
	IsDraft        bool     `json:"is_draft"`
	URL            string   `json:"url"`
	UpdatedAt      string   `json:"updated_at"`
	ReviewDecision string   `json:"review_decision"`
	Labels         []string `json:"labels,omitempty"`
}

type PullRequestComment struct {
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

type PullRequestDetail struct {
	Number             int                  `json:"number"`
	Title              string               `json:"title"`
	Body               string               `json:"body"`
	Author             string               `json:"author"`
	URL                string               `json:"url"`
	Diff               string               `json:"diff"`
	Comments           []PullRequestComment `json:"comments"`
	State              string               `json:"state"`
	IsDraft            bool                 `json:"is_draft"`
	Mergeable          bool                 `json:"mergeable"`
	HeadRef            string               `json:"head_ref"`
	HeadSHA            string               `json:"head_sha"`
	BaseRef            string               `json:"base_ref"`
	Labels             []string             `json:"labels,omitempty"`
	RequestedReviewers []string             `json:"requested_reviewers,omitempty"`
	Assignees          []string             `json:"assignees,omitempty"`
}

// ownerRepoFromRemoteURL extracts "owner/name" from a git remote URL. SSH
// host aliases (git@myalias:owner/name.git) are supported because gh is
// called with an explicit -R owner/name.
func ownerRepoFromRemoteURL(remote string) string {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ""
	}
	remote = strings.TrimSuffix(remote, ".git")
	var path string
	if strings.Contains(remote, "://") {
		u, err := url.Parse(remote)
		if err != nil {
			return ""
		}
		path = strings.TrimPrefix(u.Path, "/")
	} else if idx := strings.LastIndex(remote, ":"); idx >= 0 {
		path = remote[idx+1:]
	} else {
		return ""
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 || parts[len(parts)-2] == "" || parts[len(parts)-1] == "" {
		return ""
	}
	return parts[len(parts)-2] + "/" + parts[len(parts)-1]
}

func githubRepoSlug(repo string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", repo, "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return ownerRepoFromRemoteURL(string(output))
}

// RepoGitHubOwner returns the org/user that owns repo's origin remote —
// e.g. "someuser" from git@github.com:someuser/somerepo.git — distinct
// from the local git identity Source Control also shows (which is just
// whatever this machine happens to be configured to commit as here, not
// who actually owns the project, e.g. after cloning someone else's repo).
// Purely local (a git remote read + string parse, same as githubRepoSlug);
// unlike GitHubStatus, this never calls the network or checks auth, so
// it's cheap enough to fetch on every repo selection.
func (a *App) RepoGitHubOwner(repo string) string {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return ""
	}
	owner, _, found := strings.Cut(slug, "/")
	if !found {
		return ""
	}
	return owner
}

func (a *App) GitHubStatus(repo string) GitHubStatus {
	status := GitHubStatus{Configured: loadAppConfig().GitHubClientID != ""}
	if repo != "" {
		status.Repo = githubRepoSlug(repo)
	}
	token, source := resolveGithubToken()
	status.Source = source
	if token == "" {
		if status.Configured {
			status.Message = "Not logged in yet. Use Connect GitHub to sign in from your browser."
		} else {
			status.Message = "GitHub is not set up. Open Connect GitHub and paste the OAuth app client id once."
		}
		return status
	}
	data, err := githubAPI(http.MethodGet, "/user", token, "", nil)
	if err != nil {
		status.Message = "Stored login was rejected — sign in again. (" + err.Error() + ")"
		return status
	}
	var user struct {
		Login string `json:"login"`
	}
	_ = json.Unmarshal(data, &user)
	status.Authenticated = true
	status.Login = user.Login
	if repo != "" && status.Repo == "" {
		status.Message = "This repository has no usable origin remote."
	}
	return status
}

// PullRequestFilter narrows ListPullRequests down the same way github.com's
// PR list filter bar does. All fields are optional (zero value = no filter).
type PullRequestFilter struct {
	State  string `json:"state"`  // "open" | "closed" | "merged" | "all" ("" behaves like "open")
	Author string `json:"author"` // GitHub login
	Label  string `json:"label"`
	Search string `json:"search"` // free text matched against title/body
}

// buildPullRequestSearchQuery turns a PullRequestFilter into a GitHub search
// qualifier string, e.g. "repo:owner/name is:pr is:open author:thanh".
func buildPullRequestSearchQuery(slug string, filter PullRequestFilter) string {
	parts := []string{"repo:" + slug, "is:pr"}
	switch strings.ToLower(strings.TrimSpace(filter.State)) {
	case "closed":
		// "is:closed" alone also matches merged PRs on GitHub, since a
		// merged PR is closed too — exclude those to keep Closed and
		// Merged as distinct filter options, matching github.com's tabs.
		parts = append(parts, "is:closed", "-is:merged")
	case "merged":
		parts = append(parts, "is:merged")
	case "all":
		// no state qualifier
	default:
		parts = append(parts, "is:open")
	}
	if author := strings.TrimSpace(filter.Author); author != "" {
		parts = append(parts, "author:"+author)
	}
	if label := strings.TrimSpace(filter.Label); label != "" {
		parts = append(parts, fmt.Sprintf("label:%q", label))
	}
	query := strings.Join(parts, " ")
	if search := strings.TrimSpace(filter.Search); search != "" {
		query += " " + search
	}
	return query
}

func (a *App) ListPullRequests(repo string, filter PullRequestFilter) ([]PullRequest, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	// GraphQL's `search` field (unlike repository.pullRequests) accepts a
	// github.com-style search query string directly, so state/author/
	// label/text filters all fold into one round trip alongside the PR
	// fields the list/detail views need (isDraft, reviewDecision, labels).
	searchQuery := buildPullRequestSearchQuery(slug, filter)
	payload, _ := json.Marshal(map[string]any{
		"query": `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{
			number title url updatedAt isDraft reviewDecision state
			author{login} headRefName baseRefName
			labels(first:20){nodes{name}}
		}}}}`,
		"variables": map[string]any{"q": searchQuery},
	})
	data, err := githubAPI(http.MethodPost, "/graphql", token, "", payload)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Data struct {
			Search struct {
				Nodes []struct {
					Number int    `json:"number"`
					Title  string `json:"title"`
					Author struct {
						Login string `json:"login"`
					} `json:"author"`
					HeadRefName    string `json:"headRefName"`
					BaseRefName    string `json:"baseRefName"`
					IsDraft        bool   `json:"isDraft"`
					URL            string `json:"url"`
					UpdatedAt      string `json:"updatedAt"`
					ReviewDecision string `json:"reviewDecision"`
					State          string `json:"state"`
					Labels         struct {
						Nodes []struct {
							Name string `json:"name"`
						} `json:"nodes"`
					} `json:"labels"`
				} `json:"nodes"`
			} `json:"search"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	if len(raw.Errors) > 0 {
		return nil, fmt.Errorf("GitHub API: %s", raw.Errors[0].Message)
	}
	prs := []PullRequest{}
	for _, item := range raw.Data.Search.Nodes {
		var labels []string
		for _, l := range item.Labels.Nodes {
			labels = append(labels, l.Name)
		}
		prs = append(prs, PullRequest{
			Number:         item.Number,
			Title:          item.Title,
			Author:         item.Author.Login,
			HeadRef:        item.HeadRefName,
			BaseRef:        item.BaseRefName,
			State:          item.State,
			IsDraft:        item.IsDraft,
			URL:            item.URL,
			UpdatedAt:      item.UpdatedAt,
			ReviewDecision: item.ReviewDecision,
			Labels:         labels,
		})
	}
	return prs, nil
}

// PullRequestCounts mirrors the counts shown on github.com's own Open/Closed
// tabs above the PR list, computed for the given filter (so switching
// author/label/search updates the counts on all four tabs, not just the
// currently selected one).
type PullRequestCounts struct {
	Open   int `json:"open"`
	Closed int `json:"closed"`
	Merged int `json:"merged"`
}

func (a *App) CountPullRequests(repo string, filter PullRequestFilter) (PullRequestCounts, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return PullRequestCounts{}, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return PullRequestCounts{}, fmt.Errorf("not logged in to GitHub")
	}
	openFilter, closedFilter, mergedFilter := filter, filter, filter
	openFilter.State, closedFilter.State, mergedFilter.State = "open", "closed", "merged"
	payload, _ := json.Marshal(map[string]any{
		"query": `query($qo:String!,$qc:String!,$qm:String!){
			openCount: search(query:$qo,type:ISSUE){issueCount}
			closedCount: search(query:$qc,type:ISSUE){issueCount}
			mergedCount: search(query:$qm,type:ISSUE){issueCount}
		}`,
		"variables": map[string]any{
			"qo": buildPullRequestSearchQuery(slug, openFilter),
			"qc": buildPullRequestSearchQuery(slug, closedFilter),
			"qm": buildPullRequestSearchQuery(slug, mergedFilter),
		},
	})
	data, err := githubAPI(http.MethodPost, "/graphql", token, "", payload)
	if err != nil {
		return PullRequestCounts{}, err
	}
	var raw struct {
		Data struct {
			OpenCount struct {
				IssueCount int `json:"issueCount"`
			} `json:"openCount"`
			ClosedCount struct {
				IssueCount int `json:"issueCount"`
			} `json:"closedCount"`
			MergedCount struct {
				IssueCount int `json:"issueCount"`
			} `json:"mergedCount"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return PullRequestCounts{}, err
	}
	if len(raw.Errors) > 0 {
		return PullRequestCounts{}, fmt.Errorf("GitHub API: %s", raw.Errors[0].Message)
	}
	return PullRequestCounts{
		Open:   raw.Data.OpenCount.IssueCount,
		Closed: raw.Data.ClosedCount.IssueCount,
		Merged: raw.Data.MergedCount.IssueCount,
	}, nil
}

// ListPullRequestAuthors returns the distinct set of pull request authors in
// the repository (up to the 100 most recent PRs), used to populate the
// Author filter dropdown the same way github.com's PR list does.
func (a *App) ListPullRequestAuthors(repo string) ([]string, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	payload, _ := json.Marshal(map[string]any{
		"query":     `query($q:String!){search(query:$q,type:ISSUE,first:100){nodes{... on PullRequest{author{login}}}}}`,
		"variables": map[string]any{"q": "repo:" + slug + " is:pr"},
	})
	data, err := githubAPI(http.MethodPost, "/graphql", token, "", payload)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Data struct {
			Search struct {
				Nodes []struct {
					Author struct {
						Login string `json:"login"`
					} `json:"author"`
				} `json:"nodes"`
			} `json:"search"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	if len(raw.Errors) > 0 {
		return nil, fmt.Errorf("GitHub API: %s", raw.Errors[0].Message)
	}
	seen := map[string]bool{}
	authors := []string{}
	for _, node := range raw.Data.Search.Nodes {
		login := node.Author.Login
		if login != "" && !seen[login] {
			seen[login] = true
			authors = append(authors, login)
		}
	}
	sort.Strings(authors)
	return authors, nil
}

func (a *App) PullRequestDetail(repo string, number int) (PullRequestDetail, error) {
	detail := PullRequestDetail{Number: number}
	slug := githubRepoSlug(repo)
	if slug == "" {
		return detail, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return detail, fmt.Errorf("not logged in to GitHub")
	}
	base := fmt.Sprintf("/repos/%s/pulls/%d", slug, number)
	data, err := githubAPI(http.MethodGet, base, token, "", nil)
	if err != nil {
		return detail, err
	}
	var raw struct {
		Title string `json:"title"`
		Body  string `json:"body"`
		User  struct {
			Login string `json:"login"`
		} `json:"user"`
		HTMLURL   string `json:"html_url"`
		State     string `json:"state"`
		Draft     bool   `json:"draft"`
		Mergeable bool   `json:"mergeable"`
		Head      struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
		} `json:"base"`
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
		RequestedReviewers []struct {
			Login string `json:"login"`
		} `json:"requested_reviewers"`
		Assignees []struct {
			Login string `json:"login"`
		} `json:"assignees"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return detail, err
	}
	detail.Title = raw.Title
	detail.Body = raw.Body
	detail.URL = raw.HTMLURL
	detail.Author = raw.User.Login
	detail.State = strings.ToUpper(raw.State)
	detail.IsDraft = raw.Draft
	detail.Mergeable = raw.Mergeable
	detail.HeadRef = raw.Head.Ref
	detail.HeadSHA = raw.Head.SHA
	detail.BaseRef = raw.Base.Ref
	for _, l := range raw.Labels {
		detail.Labels = append(detail.Labels, l.Name)
	}
	for _, r := range raw.RequestedReviewers {
		detail.RequestedReviewers = append(detail.RequestedReviewers, r.Login)
	}
	for _, u := range raw.Assignees {
		detail.Assignees = append(detail.Assignees, u.Login)
	}
	if comments, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/issues/%d/comments?per_page=50", slug, number), token, "", nil); err == nil {
		var rawComments []struct {
			User struct {
				Login string `json:"login"`
			} `json:"user"`
			Body      string `json:"body"`
			CreatedAt string `json:"created_at"`
		}
		if json.Unmarshal(comments, &rawComments) == nil {
			for _, comment := range rawComments {
				detail.Comments = append(detail.Comments, PullRequestComment{
					Author:    comment.User.Login,
					Body:      comment.Body,
					CreatedAt: comment.CreatedAt,
				})
			}
		}
	}
	if diff, err := githubAPI(http.MethodGet, base, token, "application/vnd.github.diff", nil); err == nil {
		text := string(diff)
		const maxDiff = 200 * 1024
		if len(text) > maxDiff {
			text = text[:maxDiff] + "\n\n… diff truncated for preview …"
		}
		detail.Diff = text
	} else {
		detail.Diff = "Could not load diff: " + err.Error()
	}
	return detail, nil
}

// ReviewPullRequest submits a review: action is approve, request-changes, or
// comment. GitHub requires a body for everything except approve.
func (a *App) ReviewPullRequest(repo string, number int, action, body string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	var event string
	switch action {
	case "approve":
		event = "APPROVE"
	case "request-changes":
		event = "REQUEST_CHANGES"
	case "comment":
		event = "COMMENT"
	default:
		return fmt.Errorf("unknown review action %q", action)
	}
	if action != "approve" && strings.TrimSpace(body) == "" {
		return fmt.Errorf("a comment is required for %s", action)
	}
	payload, _ := json.Marshal(map[string]string{"body": body, "event": event})
	_, err := githubAPI(http.MethodPost, fmt.Sprintf("/repos/%s/pulls/%d/reviews", slug, number), token, "", payload)
	return err
}

// MergePullRequest merges a pull request using the given method: "merge",
// "squash", or "rebase" — the same three options GitHub's own merge button
// offers.
func (a *App) MergePullRequest(repo string, number int, method string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	switch method {
	case "merge", "squash", "rebase":
	default:
		return fmt.Errorf("unknown merge method %q", method)
	}
	payload, _ := json.Marshal(map[string]string{"merge_method": method})
	_, err := githubAPI(http.MethodPut, fmt.Sprintf("/repos/%s/pulls/%d/merge", slug, number), token, "", payload)
	return err
}

func setPullRequestState(repo string, number int, state string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	payload, _ := json.Marshal(map[string]string{"state": state})
	_, err := githubAPI(http.MethodPatch, fmt.Sprintf("/repos/%s/pulls/%d", slug, number), token, "", payload)
	return err
}

// ClosePullRequest closes an open pull request without merging it.
func (a *App) ClosePullRequest(repo string, number int) error {
	return setPullRequestState(repo, number, "closed")
}

// ReopenPullRequest reopens a closed (but not merged) pull request.
func (a *App) ReopenPullRequest(repo string, number int) error {
	return setPullRequestState(repo, number, "open")
}

// pullRequestNodeID fetches a pull request's GraphQL node id, needed for
// mutations that only exist in the GraphQL API (like marking a PR ready
// for review) and take a node id rather than a repo+number pair.
func pullRequestNodeID(slug string, number int, token string) (string, error) {
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/pulls/%d", slug, number), token, "", nil)
	if err != nil {
		return "", err
	}
	var raw struct {
		NodeID string `json:"node_id"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return "", err
	}
	if raw.NodeID == "" {
		return "", fmt.Errorf("could not resolve pull request node id")
	}
	return raw.NodeID, nil
}

// MarkPullRequestReadyForReview takes a draft PR out of draft. There is no
// REST endpoint for this — GitHub only exposes it through GraphQL — so the
// PR's node id is resolved first.
func (a *App) MarkPullRequestReadyForReview(repo string, number int) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	nodeID, err := pullRequestNodeID(slug, number, token)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{
		"query":     `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}`,
		"variables": map[string]any{"id": nodeID},
	})
	data, err := githubAPI(http.MethodPost, "/graphql", token, "", payload)
	if err != nil {
		return err
	}
	var raw struct {
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if json.Unmarshal(data, &raw) == nil && len(raw.Errors) > 0 {
		return fmt.Errorf("GitHub API: %s", raw.Errors[0].Message)
	}
	return nil
}

// RequestReviewers requests review on a pull request from the given GitHub
// logins.
func (a *App) RequestReviewers(repo string, number int, reviewers []string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if len(reviewers) == 0 {
		return fmt.Errorf("no reviewers given")
	}
	payload, _ := json.Marshal(map[string][]string{"reviewers": reviewers})
	_, err := githubAPI(http.MethodPost, fmt.Sprintf("/repos/%s/pulls/%d/requested_reviewers", slug, number), token, "", payload)
	return err
}

// RemoveReviewers withdraws a pending review request from the given GitHub
// logins — the counterpart to RequestReviewers, so the reviewer picker can
// behave like a real checkbox list (check to request, uncheck to withdraw).
func (a *App) RemoveReviewers(repo string, number int, reviewers []string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if len(reviewers) == 0 {
		return fmt.Errorf("no reviewers given")
	}
	payload, _ := json.Marshal(map[string][]string{"reviewers": reviewers})
	_, err := githubAPI(http.MethodDelete, fmt.Sprintf("/repos/%s/pulls/%d/requested_reviewers", slug, number), token, "", payload)
	return err
}

// AddAssignees assigns the given GitHub logins to a pull request (pull
// requests share the issues assignees endpoint on GitHub, same as labels).
func (a *App) AddAssignees(repo string, number int, assignees []string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if len(assignees) == 0 {
		return fmt.Errorf("no assignees given")
	}
	payload, _ := json.Marshal(map[string][]string{"assignees": assignees})
	_, err := githubAPI(http.MethodPost, fmt.Sprintf("/repos/%s/issues/%d/assignees", slug, number), token, "", payload)
	return err
}

// RemoveAssignees unassigns the given GitHub logins from a pull request.
func (a *App) RemoveAssignees(repo string, number int, assignees []string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if len(assignees) == 0 {
		return fmt.Errorf("no assignees given")
	}
	payload, _ := json.Marshal(map[string][]string{"assignees": assignees})
	_, err := githubAPI(http.MethodDelete, fmt.Sprintf("/repos/%s/issues/%d/assignees", slug, number), token, "", payload)
	return err
}

// SetPullRequestLabels replaces a pull request's full label set (pull
// requests share the issues label endpoint on GitHub).
func (a *App) SetPullRequestLabels(repo string, number int, labels []string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if labels == nil {
		labels = []string{}
	}
	payload, _ := json.Marshal(map[string][]string{"labels": labels})
	_, err := githubAPI(http.MethodPut, fmt.Sprintf("/repos/%s/issues/%d/labels", slug, number), token, "", payload)
	return err
}

// ListRepositoryLabels returns every label defined on the repository, used
// to populate the PR label picker — GitHub requires a label to already
// exist on the repo before it can be attached to a pull request.
func (a *App) ListRepositoryLabels(repo string) ([]string, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/labels?per_page=100", slug), token, "", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	labels := []string{}
	for _, l := range raw {
		labels = append(labels, l.Name)
	}
	return labels, nil
}

// ListRepositoryCollaborators returns everyone with push access to the
// repository, used to populate the reviewer/assignee pickers — GitHub only
// allows requesting review from or assigning a collaborator, not an
// arbitrary username.
func (a *App) ListRepositoryCollaborators(repo string) ([]string, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/collaborators?per_page=100", slug), token, "", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Login string `json:"login"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	logins := []string{}
	for _, u := range raw {
		logins = append(logins, u.Login)
	}
	return logins, nil
}

// CreatePullRequest opens a new pull request from head into base.
func (a *App) CreatePullRequest(repo, base, head, title, body string, draft bool) (PullRequest, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return PullRequest{}, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return PullRequest{}, fmt.Errorf("not logged in to GitHub")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return PullRequest{}, fmt.Errorf("title is required")
	}
	base = strings.TrimSpace(base)
	head = strings.TrimSpace(head)
	if base == "" || head == "" {
		return PullRequest{}, fmt.Errorf("base and head branches are required")
	}
	payload, _ := json.Marshal(map[string]any{
		"title": title, "head": head, "base": base, "body": body, "draft": draft,
	})
	data, err := githubAPI(http.MethodPost, fmt.Sprintf("/repos/%s/pulls", slug), token, "", payload)
	if err != nil {
		return PullRequest{}, err
	}
	var raw struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		HTMLURL string `json:"html_url"`
		Draft   bool   `json:"draft"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return PullRequest{}, err
	}
	return PullRequest{
		Number:  raw.Number,
		Title:   raw.Title,
		Author:  raw.User.Login,
		HeadRef: head,
		BaseRef: base,
		State:   "OPEN",
		IsDraft: raw.Draft,
		URL:     raw.HTMLURL,
	}, nil
}

// PullRequestCommit is one commit belonging to a pull request (the PR's
// "Commits" tab on github.com).
type PullRequestCommit struct {
	SHA     string `json:"sha"`
	Message string `json:"message"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

// PullRequestCommits lists the commits that make up a pull request.
func (a *App) PullRequestCommits(repo string, number int) ([]PullRequestCommit, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/pulls/%d/commits?per_page=100", slug, number), token, "", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Name string `json:"name"`
				Date string `json:"date"`
			} `json:"author"`
		} `json:"commit"`
		Author struct {
			Login string `json:"login"`
		} `json:"author"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	commits := []PullRequestCommit{}
	for _, c := range raw {
		author := c.Author.Login
		if author == "" {
			author = c.Commit.Author.Name
		}
		commits = append(commits, PullRequestCommit{SHA: c.SHA, Message: c.Commit.Message, Author: author, Date: c.Commit.Author.Date})
	}
	return commits, nil
}

// CheckRun mirrors one entry of the PR's "Checks" tab on github.com (CI
// status for the head commit).
type CheckRun struct {
	Name       string `json:"name"`
	Status     string `json:"status"`     // queued | in_progress | completed
	Conclusion string `json:"conclusion"` // success | failure | neutral | cancelled | timed_out | action_required | skipped | ""
	URL        string `json:"url"`
}

// PullRequestChecks returns CI check runs for the PR's current head commit.
func (a *App) PullRequestChecks(repo string, number int) ([]CheckRun, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	prData, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/pulls/%d", slug, number), token, "", nil)
	if err != nil {
		return nil, err
	}
	var prRaw struct {
		Head struct {
			SHA string `json:"sha"`
		} `json:"head"`
	}
	if err := json.Unmarshal(prData, &prRaw); err != nil {
		return nil, err
	}
	if prRaw.Head.SHA == "" {
		return []CheckRun{}, nil
	}
	// A commit with no check runs configured is a normal state, not an
	// error — GitHub's check-runs endpoint can 404 for some ref shapes
	// (e.g. a fork's head commit not otherwise reachable in this repo), so
	// this is treated as "no checks" rather than surfaced to the user.
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/commits/%s/check-runs?per_page=100", slug, prRaw.Head.SHA), token, "", nil)
	if err != nil {
		return []CheckRun{}, nil
	}
	var raw struct {
		CheckRuns []struct {
			Name       string `json:"name"`
			Status     string `json:"status"`
			Conclusion string `json:"conclusion"`
			HTMLURL    string `json:"html_url"`
		} `json:"check_runs"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	checks := []CheckRun{}
	for _, c := range raw.CheckRuns {
		checks = append(checks, CheckRun{Name: c.Name, Status: c.Status, Conclusion: c.Conclusion, URL: c.HTMLURL})
	}
	return checks, nil
}

// PullRequestFile is one file's changes within a pull request, including its
// own unified diff hunk (Patch) — used for the "Files changed" tab so each
// file can be diffed independently instead of parsing one combined blob.
type PullRequestFile struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previous_filename,omitempty"`
	Status           string `json:"status"` // added | removed | modified | renamed
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Patch            string `json:"patch,omitempty"` // absent for binary or very large files
}

// PullRequestFiles lists the files changed by a pull request.
func (a *App) PullRequestFiles(repo string, number int) ([]PullRequestFile, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/pulls/%d/files?per_page=100", slug, number), token, "", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		Filename         string `json:"filename"`
		PreviousFilename string `json:"previous_filename"`
		Status           string `json:"status"`
		Additions        int    `json:"additions"`
		Deletions        int    `json:"deletions"`
		Patch            string `json:"patch"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	files := []PullRequestFile{}
	for _, f := range raw {
		files = append(files, PullRequestFile{
			Filename: f.Filename, PreviousFilename: f.PreviousFilename, Status: f.Status,
			Additions: f.Additions, Deletions: f.Deletions, Patch: f.Patch,
		})
	}
	return files, nil
}

// ReviewComment is a single- or multi-line inline comment attached to a
// specific file/line in a pull request's diff (github.com's "Files changed"
// line comments).
type ReviewComment struct {
	ID        int64  `json:"id"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
	Side      string `json:"side"` // LEFT | RIGHT
	StartLine int    `json:"start_line,omitempty"`
	StartSide string `json:"start_side,omitempty"`
	Body      string `json:"body"`
	Author    string `json:"author"`
	CreatedAt string `json:"created_at"`
	InReplyTo int64  `json:"in_reply_to,omitempty"`
}

// ListReviewComments returns every inline diff comment on a pull request.
func (a *App) ListReviewComments(repo string, number int) ([]ReviewComment, error) {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return nil, fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return nil, fmt.Errorf("not logged in to GitHub")
	}
	data, err := githubAPI(http.MethodGet, fmt.Sprintf("/repos/%s/pulls/%d/comments?per_page=100", slug, number), token, "", nil)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		ID   int64  `json:"id"`
		Path string `json:"path"`
		Line int    `json:"line"`
		Side string `json:"side"`
		// GitHub returns "original_line"/"original_side" once a comment's
		// diff position becomes outdated (line is then null) — falling
		// back to those keeps old comments visible instead of losing them.
		OriginalLine int    `json:"original_line"`
		StartLine    int    `json:"start_line"`
		StartSide    string `json:"start_side"`
		Body         string `json:"body"`
		User         struct {
			Login string `json:"login"`
		} `json:"user"`
		CreatedAt   string `json:"created_at"`
		InReplyToID int64  `json:"in_reply_to_id"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	comments := []ReviewComment{}
	for _, c := range raw {
		line := c.Line
		if line == 0 {
			line = c.OriginalLine
		}
		comments = append(comments, ReviewComment{
			ID: c.ID, Path: c.Path, Line: line, Side: c.Side,
			StartLine: c.StartLine, StartSide: c.StartSide, Body: c.Body,
			Author: c.User.Login, CreatedAt: c.CreatedAt, InReplyTo: c.InReplyToID,
		})
	}
	return comments, nil
}

// CreateReviewComment posts a new inline diff comment. startLine/startSide
// are only sent when non-zero/non-empty, turning a single-line comment into
// a multi-line range comment (line/side is always the range's end).
func (a *App) CreateReviewComment(repo string, number int, commitID, path string, line int, side string, startLine int, startSide string, body string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if strings.TrimSpace(body) == "" {
		return fmt.Errorf("comment body is empty")
	}
	payload := map[string]any{"body": body, "commit_id": commitID, "path": path, "line": line, "side": side}
	if startLine > 0 {
		payload["start_line"] = startLine
		payload["start_side"] = startSide
	}
	data, _ := json.Marshal(payload)
	_, err := githubAPI(http.MethodPost, fmt.Sprintf("/repos/%s/pulls/%d/comments", slug, number), token, "", data)
	return err
}

// ReplyToReviewComment adds a reply within an existing inline comment
// thread.
func (a *App) ReplyToReviewComment(repo string, number int, commentID int64, body string) error {
	slug := githubRepoSlug(repo)
	if slug == "" {
		return fmt.Errorf("no GitHub repository detected for %s", repo)
	}
	token := githubToken()
	if token == "" {
		return fmt.Errorf("not logged in to GitHub")
	}
	if strings.TrimSpace(body) == "" {
		return fmt.Errorf("reply body is empty")
	}
	payload, _ := json.Marshal(map[string]any{"body": body, "in_reply_to": commentID})
	_, err := githubAPI(http.MethodPost, fmt.Sprintf("/repos/%s/pulls/%d/comments", slug, number), token, "", payload)
	return err
}
