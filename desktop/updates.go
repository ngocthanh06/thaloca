package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// AppVersion is Thaloca's own version — bump this (and
// desktop/frontend/package.json's "version") together when cutting a
// release. There's no build-time version-injection set up, so it's a
// plain constant kept in sync by hand.
const AppVersion = "0.1.4"

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
// release tag. This is a check-and-notify mechanism, not a silent
// auto-installer: Thaloca is only ad-hoc code-signed (no Apple Developer
// ID/notarization set up — see README's Packaging section), so a real
// background download-and-replace would still hit the same Gatekeeper
// friction a manual download does, without the transparency of the user
// choosing when to update. Finding a newer release just surfaces a
// download link; installing it is still a manual DMG replace.
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
		if info.Available {
			a.notifyOnce("update:"+info.LatestVersion, "update_available",
				"Update available",
				fmt.Sprintf("Thaloca %s is available (you have %s).", info.LatestVersion, info.CurrentVersion))
		}
	}
	check()
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		check()
	}
}
