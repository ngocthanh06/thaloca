package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// InstalledApp is one detected .app bundle (from /Applications or
// ~/Applications), enriched with best-effort resource usage aggregated
// from any currently-running process whose executable lives inside it.
type InstalledApp struct {
	Name       string  `json:"name"`
	BundleID   string  `json:"bundle_id"`
	Version    string  `json:"version"`
	Path       string  `json:"path"`
	Running    bool    `json:"running"`
	CPUPercent float64 `json:"cpu_percent"`
	MemPercent float64 `json:"mem_percent"`
}

// InstalledApps returns every detected .app bundle with live CPU/Mem usage
// aggregated from currently-running processes. Bundle metadata (name/id/
// version) is cached (see RefreshInstalledApps) and only the usage
// aggregation is recomputed each call.
func (a *App) InstalledApps() []InstalledApp {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	a.appsMu.Lock()
	cached := a.appsCache
	a.appsMu.Unlock()
	if cached == nil {
		cached = a.RefreshInstalledApps()
	}

	processes := readProcesses(ctx)
	apps := make([]InstalledApp, len(cached))
	copy(apps, cached)
	for i := range apps {
		apps[i].CPUPercent, apps[i].MemPercent, apps[i].Running = aggregateAppUsage(apps[i].Path, processes)
	}
	return apps
}

// RefreshInstalledApps re-scans /Applications and ~/Applications for .app
// bundles and caches their static metadata. Enumerating and reading dozens
// of Info.plist files via `plutil` isn't worth paying for on every 5s
// Resources poll — apps come and go far less often than that, so only this
// explicit refresh (the tab's "Refresh" button) re-scans.
func (a *App) RefreshInstalledApps() []InstalledApp {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var apps []InstalledApp
	roots := []string{"/Applications"}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots, filepath.Join(home, "Applications"))
	}
	seen := map[string]bool{}
	for _, root := range roots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasSuffix(entry.Name(), ".app") {
				continue
			}
			appPath := filepath.Join(root, entry.Name())
			if seen[appPath] {
				continue
			}
			seen[appPath] = true
			if app, ok := readAppInfo(ctx, appPath); ok {
				apps = append(apps, app)
			}
		}
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].Name < apps[j].Name })

	a.appsMu.Lock()
	a.appsCache = apps
	a.appsMu.Unlock()
	return apps
}

// readAppInfo shells out to macOS's own `plutil` to convert an Info.plist
// (binary or XML) to JSON, rather than embedding a plist-parsing library —
// consistent with this app's general approach of wrapping system binaries
// (git, ssh, docker, brew) instead of adding dependencies for what the OS
// already provides.
func readAppInfo(ctx context.Context, appPath string) (InstalledApp, bool) {
	plistPath := filepath.Join(appPath, "Contents", "Info.plist")
	out, err := exec.CommandContext(ctx, "plutil", "-convert", "json", "-o", "-", plistPath).Output()
	if err != nil {
		return InstalledApp{}, false
	}
	var info struct {
		Name        string `json:"CFBundleName"`
		DisplayName string `json:"CFBundleDisplayName"`
		BundleID    string `json:"CFBundleIdentifier"`
		Version     string `json:"CFBundleShortVersionString"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		return InstalledApp{}, false
	}
	if info.BundleID == "" {
		return InstalledApp{}, false
	}
	name := info.DisplayName
	if name == "" {
		name = info.Name
	}
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(appPath), ".app")
	}
	return InstalledApp{Name: name, BundleID: info.BundleID, Version: info.Version, Path: appPath}, true
}

// OpenInstalledApp launches an app bundle via macOS's own `open` command —
// the same thing double-clicking it in Finder or the Dock does.
func (a *App) OpenInstalledApp(appPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "open", appPath).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}

// QuitInstalledApp asks a running app to quit gracefully (equivalent to
// Cmd+Q) via AppleScript, addressed by bundle ID rather than by name so it
// still works if two apps share a display name. Quotes are escaped the same
// way Notify's AppleScript call is, even though a bundle ID read from the
// app's own Info.plist is not attacker input in practice.
func (a *App) QuitInstalledApp(bundleID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	escaped := strings.ReplaceAll(bundleID, `"`, `\"`)
	script := fmt.Sprintf(`tell application id "%s" to quit`, escaped)
	out, err := exec.CommandContext(ctx, "osascript", "-e", script).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}

// aggregateAppUsage sums CPU%/Mem% across every currently-running process
// whose executable path lives inside appPath — a best-effort proxy for
// "how much is this app costing right now" since macOS has no single API
// tying a group of processes back to the .app bundle that launched them.
func aggregateAppUsage(appPath string, processes []ProcessInfo) (cpu, mem float64, running bool) {
	prefix := appPath + "/"
	for _, p := range processes {
		if p.Path == appPath || strings.HasPrefix(p.Path, prefix) {
			cpu += p.CPUPercent
			mem += p.MemPercent
			running = true
		}
	}
	return
}
