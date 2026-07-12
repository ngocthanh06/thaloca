package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ConfigBackup bundles every local preference Thaloca keeps so it can be
// moved to a new machine. Server entries only ever contain a key PATH,
// never the key's contents (Thaloca never reads it), so nothing here needs
// redaction — there is no secret to redact in the first place.
type ConfigBackup struct {
	Servers              []ServerConnection   `json:"servers"`
	IgnoredRepos         []string             `json:"ignored_repos"`
	EventRepos           []string             `json:"event_repos"`
	MineOnly             bool                 `json:"mine_only"`
	PinnedRepos          []string             `json:"pinned_repos"`
	NotificationSettings NotificationSettings `json:"notification_settings"`
	ExportedAt           string               `json:"exported_at"`
}

// ExportConfig bundles servers, repo preferences, and notification
// settings into one JSON file via a native save dialog. pinnedRepos is
// passed in from the frontend since pinning lives in browser localStorage,
// not a Go-side file. Returns "" (no error) if the user cancels the dialog.
func (a *App) ExportConfig(pinnedRepos []string) (string, error) {
	path, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:           "Export Thaloca config",
		DefaultFilename: "thaloca-config.json",
		Filters:         []wailsruntime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return "", err
	}

	settings := loadUserSettings()
	backup := ConfigBackup{
		Servers:              loadServers(),
		IgnoredRepos:         sortedKeys(settings.IgnoredRepos),
		EventRepos:           sortedKeys(settings.EventRepos),
		MineOnly:             settings.MineOnly,
		PinnedRepos:          pinnedRepos,
		NotificationSettings: loadNotificationSettings(),
		ExportedAt:           time.Now().Format(time.RFC3339),
	}
	data, err := json.MarshalIndent(backup, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// ImportConfig reads a previously exported bundle (via a native open
// dialog) and restores servers, repo preferences, and notification
// settings. PinnedRepos is returned (not restored here) for the frontend
// to write back into its own localStorage.
func (a *App) ImportConfig() (ConfigBackup, error) {
	path, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title:   "Import Thaloca config",
		Filters: []wailsruntime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return ConfigBackup{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ConfigBackup{}, err
	}
	var backup ConfigBackup
	if err := json.Unmarshal(data, &backup); err != nil {
		return ConfigBackup{}, fmt.Errorf("invalid config file: %w", err)
	}

	// A server entry with a Host/User an attacker (or a corrupted file)
	// could shape into an SSH option (see isSafeSSHArg) is dropped rather
	// than failing the whole import — the same validation AddServer
	// applies when a server is added by hand.
	safeServers := make([]ServerConnection, 0, len(backup.Servers))
	for _, s := range backup.Servers {
		if isSafeSSHArg(s.Host) && isSafeSSHArg(s.User) {
			safeServers = append(safeServers, s)
		}
	}
	if err := saveServers(safeServers); err != nil {
		return ConfigBackup{}, err
	}
	backup.Servers = safeServers

	settings := userSettings{
		IgnoredRepos: sliceToSet(backup.IgnoredRepos),
		EventRepos:   sliceToSet(backup.EventRepos),
		MineOnly:     backup.MineOnly,
	}
	if err := saveUserSettings(settings); err != nil {
		return ConfigBackup{}, err
	}

	// A config file that predates notification settings (or was hand-
	// edited without that field) unmarshals NotificationSettings as its
	// Go zero value — every toggle false — which would otherwise silently
	// switch off every notification. Only overwrite if the imported value
	// looks like it was actually set.
	if backup.NotificationSettings != (NotificationSettings{}) {
		if err := saveNotificationSettings(backup.NotificationSettings); err != nil {
			return ConfigBackup{}, err
		}
	} else {
		backup.NotificationSettings = loadNotificationSettings()
	}
	return backup, nil
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func sliceToSet(s []string) map[string]bool {
	set := make(map[string]bool, len(s))
	for _, v := range s {
		set[v] = true
	}
	return set
}
