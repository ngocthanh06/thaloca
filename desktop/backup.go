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
	Servers                   []ServerConnection   `json:"servers"`
	IgnoredRepos              []string             `json:"ignored_repos"`
	EventRepos                []string             `json:"event_repos"`
	MineOnly                  bool                 `json:"mine_only"`
	PinnedRepos               []string             `json:"pinned_repos"`
	KeyboardShortcuts         map[string]string    `json:"keyboard_shortcuts"`
	NotificationSettings      NotificationSettings `json:"notification_settings"`
	ProductPreferences        ProductPreferences   `json:"product_preferences"`
	DocumentRoots             []DocumentRoot       `json:"document_roots"`
	DocumentExclusions        []string             `json:"document_exclusions"`
	ExportedAt                string               `json:"exported_at"`
	documentRootsPresent      bool
	documentExclusionsPresent bool
}

func (backup *ConfigBackup) UnmarshalJSON(data []byte) error {
	type configBackupAlias ConfigBackup
	var decoded configBackupAlias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*backup = ConfigBackup(decoded)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	_, backup.documentRootsPresent = fields["document_roots"]
	_, backup.documentExclusionsPresent = fields["document_exclusions"]
	return nil
}

// ExportConfig bundles servers, repo preferences, and notification
// settings into one JSON file via a native save dialog. pinnedRepos and
// keyboardShortcuts are passed in from the frontend since both live in
// browser localStorage, not a Go-side file. Returns "" (no error) if the
// user cancels the dialog.
func (a *App) ExportConfig(pinnedRepos []string, keyboardShortcuts map[string]string) (string, error) {
	path, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:           "Export Thaloca config",
		DefaultFilename: "thaloca-config.json",
		Filters:         []wailsruntime.FileFilter{{DisplayName: "JSON", Pattern: "*.json"}},
	})
	if err != nil || path == "" {
		return "", err
	}

	settings := loadUserSettings()
	documents := loadDocumentLibrary()
	backup := ConfigBackup{
		Servers:              loadServers(),
		IgnoredRepos:         sortedKeys(settings.IgnoredRepos),
		EventRepos:           sortedKeys(settings.EventRepos),
		MineOnly:             settings.MineOnly,
		PinnedRepos:          pinnedRepos,
		KeyboardShortcuts:    keyboardShortcuts,
		NotificationSettings: loadNotificationSettings(),
		ProductPreferences:   loadProductPreferences(),
		DocumentRoots:        documents.Roots,
		DocumentExclusions:   documents.ExcludedPaths,
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
// settings. PinnedRepos and KeyboardShortcuts are returned (not restored
// here) for the frontend to write back into its own localStorage.
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
	if backup.ProductPreferences.ExpectedProjects != nil || backup.ProductPreferences.Workspaces != nil || backup.ProductPreferences.DocumentPolicies != nil {
		if err := saveProductPreferences(backup.ProductPreferences); err != nil {
			return ConfigBackup{}, err
		}
	}
	if backup.documentRootsPresent || backup.documentExclusionsPresent {
		documents := loadDocumentLibrary()
		if backup.documentRootsPresent {
			documents.Roots = backup.DocumentRoots
		}
		if backup.documentExclusionsPresent {
			documents.ExcludedPaths = backup.DocumentExclusions
		}
		if err := saveDocumentLibrary(documents); err != nil {
			return ConfigBackup{}, err
		}
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
