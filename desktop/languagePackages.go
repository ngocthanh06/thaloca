package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// isSafePackageName is like isSafeBrewName (desktop/brewPackages.go) but
// also allows a leading "@" for npm scoped packages (e.g. "@babel/core") —
// kept as its own function rather than loosening isSafeBrewName, since
// Homebrew names never start with "@" and there's no reason to widen what
// that one already accepts.
var safePackageNamePattern = regexp.MustCompile(`^@?[A-Za-z0-9][A-Za-z0-9_.@/-]*$`)

func isSafePackageName(name string) bool {
	return safePackageNamePattern.MatchString(name)
}

// RegistryPackage is one search result from SearchLanguagePackages.
type RegistryPackage struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// httpGetJSON fetches url (GET, no auth — all four registries below have
// public unauthenticated search APIs) and decodes the JSON body into out.
// Mirrors githubAPI's (desktop/github.go) timeout/bounded-read shape.
func httpGetJSON(reqURL, userAgent string, out any) (status int, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return 0, err
	}
	if userAgent != "" {
		req.Header.Set("User-Agent", userAgent)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, err
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("parse response: %w", err)
		}
	}
	return resp.StatusCode, nil
}

const knownRegistries = `"npm", "pypi", "cargo", or "composer"`

// SearchLanguagePackages searches one of the four language registries by
// name. PyPI is the one exception noted in the design doc: its public
// search API was disabled years ago, so its "search" is really an
// exact-name existence check (0 or 1 result) via PyPI's package-info
// endpoint, not a fuzzy search like the other three.
func (a *App) SearchLanguagePackages(registry, query string) ([]RegistryPackage, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("enter a package name to search for")
	}
	switch registry {
	case "npm":
		return searchNpm(query)
	case "pypi":
		return searchPyPI(query)
	case "cargo":
		return searchCrates(query)
	case "composer":
		return searchPackagist(query)
	default:
		return nil, fmt.Errorf("unknown registry %q (expected %s)", registry, knownRegistries)
	}
}

func searchNpm(query string) ([]RegistryPackage, error) {
	var body struct {
		Objects []struct {
			Package struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"package"`
		} `json:"objects"`
	}
	reqURL := "https://registry.npmjs.org/-/v1/search?text=" + url.QueryEscape(query) + "&size=20"
	if _, err := httpGetJSON(reqURL, "", &body); err != nil {
		return nil, fmt.Errorf("npm search: %w", err)
	}
	results := make([]RegistryPackage, 0, len(body.Objects))
	for _, o := range body.Objects {
		results = append(results, RegistryPackage{Name: o.Package.Name, Description: o.Package.Description})
	}
	return results, nil
}

// searchPyPI checks for a single exact-name match — see the package
// doc comment on SearchLanguagePackages for why this can't be a real
// fuzzy search.
func searchPyPI(query string) ([]RegistryPackage, error) {
	var body struct {
		Info struct {
			Name    string `json:"name"`
			Summary string `json:"summary"`
		} `json:"info"`
	}
	reqURL := "https://pypi.org/pypi/" + url.PathEscape(query) + "/json"
	status, err := httpGetJSON(reqURL, "", &body)
	if err != nil {
		return nil, fmt.Errorf("PyPI lookup: %w", err)
	}
	if status == http.StatusNotFound {
		return nil, nil
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("PyPI lookup: unexpected status %d", status)
	}
	return []RegistryPackage{{Name: body.Info.Name, Description: body.Info.Summary}}, nil
}

func searchCrates(query string) ([]RegistryPackage, error) {
	var body struct {
		Crates []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"crates"`
	}
	reqURL := "https://crates.io/api/v1/crates?q=" + url.QueryEscape(query) + "&per_page=20"
	// crates.io's crawler policy rejects requests with no/generic User-Agent.
	if _, err := httpGetJSON(reqURL, "Thaloca (https://github.com/thaloca/thaloca)", &body); err != nil {
		return nil, fmt.Errorf("crates.io search: %w", err)
	}
	results := make([]RegistryPackage, 0, len(body.Crates))
	for _, c := range body.Crates {
		results = append(results, RegistryPackage{Name: c.Name, Description: c.Description})
	}
	return results, nil
}

func searchPackagist(query string) ([]RegistryPackage, error) {
	var body struct {
		Results []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"results"`
	}
	reqURL := "https://packagist.org/search.json?q=" + url.QueryEscape(query)
	if _, err := httpGetJSON(reqURL, "", &body); err != nil {
		return nil, fmt.Errorf("Packagist search: %w", err)
	}
	results := make([]RegistryPackage, 0, len(body.Results))
	for _, r := range body.Results {
		results = append(results, RegistryPackage{Name: r.Name, Description: r.Description})
	}
	return results, nil
}

// ListLanguagePackages reports what's globally installed for one registry,
// read-only, no caching (each is a single fast command) — same reasoning
// as ListBrewPackages in desktop/brewPackages.go.
func (a *App) ListLanguagePackages(registry string) ([]string, error) {
	switch registry {
	case "npm":
		return listNpmGlobal()
	case "pypi":
		return listPipUser()
	case "cargo":
		return listCargoInstalled()
	case "composer":
		return listComposerGlobal()
	default:
		return nil, fmt.Errorf("unknown registry %q (expected %s)", registry, knownRegistries)
	}
}

func listNpmGlobal() ([]string, error) {
	if _, err := exec.LookPath("npm"); err != nil {
		return nil, fmt.Errorf("npm is not installed")
	}
	out, err := exec.Command("npm", "list", "-g", "--depth=0", "--json").CombinedOutput()
	// `npm list` can exit non-zero even on a successful listing (e.g. a
	// peer-dependency warning) — only treat it as fatal if the output isn't
	// parseable JSON at all.
	var parsed struct {
		Dependencies map[string]json.RawMessage `json:"dependencies"`
	}
	if jsonErr := json.Unmarshal(out, &parsed); jsonErr != nil {
		if err != nil {
			return nil, fmt.Errorf("npm list -g: %s", strings.TrimSpace(string(out)))
		}
		return nil, fmt.Errorf("npm list -g: %w", jsonErr)
	}
	names := make([]string, 0, len(parsed.Dependencies))
	for name := range parsed.Dependencies {
		names = append(names, name)
	}
	return names, nil
}

func listPipUser() ([]string, error) {
	if _, err := exec.LookPath("pip3"); err != nil {
		return nil, fmt.Errorf("pip3 is not installed")
	}
	out, err := exec.Command("pip3", "list", "--user", "--format=json").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("pip3 list: %s", strings.TrimSpace(string(out)))
	}
	var packages []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(out, &packages); err != nil {
		return nil, fmt.Errorf("pip3 list: %w", err)
	}
	names := make([]string, 0, len(packages))
	for _, p := range packages {
		names = append(names, p.Name)
	}
	return names, nil
}

// cargoInstallNameLine matches a package-header line from `cargo install
// --list` — e.g. "ripgrep v14.1.0:" — as opposed to the indented binary
// names underneath each package, which this must not match.
var cargoInstallNameLine = regexp.MustCompile(`^(\S+)\s+v\S+:$`)

func listCargoInstalled() ([]string, error) {
	if _, err := exec.LookPath("cargo"); err != nil {
		return nil, fmt.Errorf("cargo is not installed")
	}
	out, err := exec.Command("cargo", "install", "--list").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("cargo install --list: %s", strings.TrimSpace(string(out)))
	}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		if m := cargoInstallNameLine.FindStringSubmatch(line); m != nil {
			names = append(names, m[1])
		}
	}
	return names, nil
}

func listComposerGlobal() ([]string, error) {
	if _, err := exec.LookPath("composer"); err != nil {
		return nil, fmt.Errorf("composer is not installed")
	}
	out, err := exec.Command("composer", "global", "show", "--format=json").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("composer global show: %s", strings.TrimSpace(string(out)))
	}
	var body struct {
		Installed []struct {
			Name string `json:"name"`
		} `json:"installed"`
	}
	if err := json.Unmarshal(out, &body); err != nil {
		return nil, fmt.Errorf("composer global show: %w", err)
	}
	names := make([]string, 0, len(body.Installed))
	for _, p := range body.Installed {
		names = append(names, p.Name)
	}
	return names, nil
}

// InstallLanguagePackage starts the registry's global-install command in
// the background and returns a job ID immediately; poll it via the
// existing ToolActionStatus(jobID) binding (desktop/toolActions.go), same
// as InstallBrewPackage. The frontend is expected to have already shown
// the user the exact command and gotten a native confirmation first.
func (a *App) InstallLanguagePackage(registry, name string) (string, error) {
	bin, args, err := languagePackageArgs(registry, name, "install")
	if err != nil {
		return "", err
	}
	return a.startJob(registry+"-install-"+name, bin, args, nil), nil
}

// UninstallLanguagePackage is the same shape as InstallLanguagePackage.
func (a *App) UninstallLanguagePackage(registry, name string) (string, error) {
	bin, args, err := languagePackageArgs(registry, name, "uninstall")
	if err != nil {
		return "", err
	}
	return a.startJob(registry+"-uninstall-"+name, bin, args, nil), nil
}

func languagePackageArgs(registry, name, action string) (bin string, args []string, err error) {
	if !isSafePackageName(name) {
		return "", nil, fmt.Errorf("%q is not a valid package name", name)
	}
	switch registry {
	case "npm":
		bin = "npm"
		if action == "install" {
			args = []string{"install", "-g", name}
		} else {
			args = []string{"uninstall", "-g", name}
		}
	case "pypi":
		bin = "pip3"
		if action == "install" {
			args = []string{"install", "--user", name}
		} else {
			args = []string{"uninstall", "-y", name}
		}
	case "cargo":
		bin = "cargo"
		if action == "install" {
			args = []string{"install", name}
		} else {
			args = []string{"uninstall", name}
		}
	case "composer":
		bin = "composer"
		if action == "install" {
			args = []string{"global", "require", name}
		} else {
			args = []string{"global", "remove", name}
		}
	default:
		return "", nil, fmt.Errorf("unknown registry %q (expected %s)", registry, knownRegistries)
	}
	if _, err := exec.LookPath(bin); err != nil {
		return "", nil, fmt.Errorf("%s is not installed", bin)
	}
	return bin, args, nil
}
