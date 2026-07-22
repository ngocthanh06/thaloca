package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// AppVersion is Thaloca's own version — bump this, desktop/frontend/
// package.json's "version", AND desktop/wails.json's "productVersion"
// together when cutting a release. The last one is easy to miss since it
// only ever shows up as a self-update failure ("update bundle version
// does not match release") — it's what Wails bakes into the packaged
// .app's Info.plist at build time, separate from this Go constant. There's
// no build-time version-injection set up, so all three are plain values
// kept in sync by hand.
const AppVersion = "0.1.10"

// updateRepo is the GitHub repo releases are checked against. Hardcoded
// like the embedded GitHub OAuth client ID elsewhere in this app — it's
// this project's own distribution channel, not something a user configures.
const updateRepo = "ngocthanh06/thaloca"

// UpdateInfo is what CheckForUpdate reports.
type UpdateInfo struct {
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version,omitempty"`
	Available      bool   `json:"available"`
	ReleaseURL     string `json:"release_url,omitempty"`
	Error          string `json:"error,omitempty"`
}

// GetAppVersion returns Thaloca's own version string.
func (a *App) GetAppVersion() string {
	return AppVersion
}

// CheckForUpdate compares AppVersion against the GitHub repo's latest
// release tag. The background loop only notifies and Settings opens the
// release page; installation remains manual while builds are only ad-hoc
// signed and have no independent update-signing key.
func (a *App) CheckForUpdate() UpdateInfo {
	info := UpdateInfo{CurrentVersion: AppVersion}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+updateRepo+"/releases/latest", nil)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// No releases published yet — not an error, just nothing to offer.
		return info
	}
	if resp.StatusCode != http.StatusOK {
		info.Error = fmt.Sprintf("GitHub returned %d checking for updates", resp.StatusCode)
		return info
	}

	var release struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		info.Error = err.Error()
		return info
	}

	latest := strings.TrimPrefix(release.TagName, "v")
	info.LatestVersion = latest
	info.ReleaseURL = release.HTMLURL
	info.Available = latest != "" && latest != AppVersion && isNewerVersion(latest, AppVersion)
	return info
}

// isNewerVersion does a best-effort numeric dotted-version comparison
// ("0.10.0" > "0.9.0"), falling back to false (don't claim an update is
// available) for anything that doesn't parse as dotted numbers, rather than
// a potentially-wrong string comparison.
func isNewerVersion(latest, current string) bool {
	latestParts := strings.Split(latest, ".")
	currentParts := strings.Split(current, ".")
	for i := 0; i < len(latestParts) || i < len(currentParts); i++ {
		var l, c int
		if i < len(latestParts) {
			if _, err := fmt.Sscanf(latestParts[i], "%d", &l); err != nil {
				return false
			}
		}
		if i < len(currentParts) {
			if _, err := fmt.Sscanf(currentParts[i], "%d", &c); err != nil {
				return false
			}
		}
		if l != c {
			return l > c
		}
	}
	return false
}

// checkForUpdateLoop checks for a new release once at startup and then
// once every 24h, notifying (respecting the same notification
// settings/quiet hours everything else does) if one is found. This is
// separate from the on-demand CheckForUpdate binding the Settings panel's
// "Check for updates" button calls directly.
func (a *App) checkForUpdateLoop() {
	check := func() {
		info := a.CheckForUpdate()
		if !info.Available {
			return
		}
		if a.GetAutoUpdateEnabled() {
			a.notifyOnce("update-installing:"+info.LatestVersion, "update_available",
				"Installing update",
				fmt.Sprintf("Thaloca %s is downloading and will restart automatically.", info.LatestVersion))
			if err := a.PerformSelfUpdate(info.LatestVersion); err == nil {
				return
			}
			// Auto-update failed (network, verification, a newer release
			// appeared mid-download, …) — fall through to the manual
			// notification below so the user isn't left unaware a newer
			// version exists.
		}
		a.notifyOnce("update-available:"+info.LatestVersion, "update_available",
			"Update available",
			fmt.Sprintf("Thaloca %s is available (you have %s).", info.LatestVersion, info.CurrentVersion))
	}
	check()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		check()
	}
}

// GetAutoUpdateEnabled reports whether checkForUpdateLoop is allowed to
// install a newer release automatically instead of only notifying.
func (a *App) GetAutoUpdateEnabled() bool {
	return loadUserSettings().AutoUpdateEnabled
}

// SetAutoUpdateEnabled turns fully-automatic updates on or off.
func (a *App) SetAutoUpdateEnabled(enabled bool) error {
	settings := loadUserSettings()
	settings.AutoUpdateEnabled = enabled
	return saveUserSettings(settings)
}
