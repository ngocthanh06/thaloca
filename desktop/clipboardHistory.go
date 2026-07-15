package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// ClipboardEntry is one thing the user copied — inside Thaloca (an
// explicit "Copy" button, source names where it came from, or a manual
// selection + Cmd+C, source "Manual selection") or in any other app on the
// Mac (source "System clipboard" — see pollSystemClipboard).
type ClipboardEntry struct {
	ID     string `json:"id"`
	Text   string `json:"text"`
	Source string `json:"source,omitempty"`
	At     string `json:"at"`
}

const clipboardHistoryMaxAge = 24 * time.Hour

func clipboardHistoryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "clipboard-history.json"), nil
}

func loadClipboardHistoryEntries() []ClipboardEntry {
	path, err := clipboardHistoryPath()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var entries []ClipboardEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil
	}
	return entries
}

func saveClipboardHistoryEntries(entries []ClipboardEntry) error {
	path, err := clipboardHistoryPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if entries == nil {
		entries = []ClipboardEntry{}
	}
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// pruneClipboardHistory drops entries older than clipboardHistoryMaxAge —
// the automatic 24h expiry, independent of manual deletion.
func pruneClipboardHistory(entries []ClipboardEntry) []ClipboardEntry {
	cutoff := time.Now().Add(-clipboardHistoryMaxAge)
	kept := make([]ClipboardEntry, 0, len(entries))
	for _, e := range entries {
		t, err := time.Parse(time.RFC3339, e.At)
		if err == nil && t.Before(cutoff) {
			continue
		}
		kept = append(kept, e)
	}
	return kept
}

// RecordClipboardCopy appends one entry — called whenever something is
// copied, either from the frontend (an explicit Copy button or a native
// Cmd+C/manual selection) or from pollSystemClipboard noticing the system
// pasteboard changed — and returns the pruned, current history. The same
// physical copy is often seen by more than one recorder (e.g. an in-app
// Copy button AND the system-clipboard poller both notice it); if the
// most recent entry has identical text within the last few seconds, this
// is treated as the same event rather than appended again.
// clipboardEntryMaxLen caps how much of one copy is stored. A history list
// is for recognizing/reusing a recent snippet, not archiving a multi-MB
// blob — without a cap, copying a large log/SQL dump would make every
// subsequent read-modify-write of the whole file (see clipboardMu) re-
// serialize that blob until it ages out.
const clipboardEntryMaxLen = 4096

func (a *App) RecordClipboardCopy(text, source string) ([]ClipboardEntry, error) {
	if text == "" {
		return a.ClipboardHistory(), nil
	}
	if len(text) > clipboardEntryMaxLen {
		text = text[:clipboardEntryMaxLen] + "…"
	}

	a.clipboardMu.Lock()
	defer a.clipboardMu.Unlock()

	entries := pruneClipboardHistory(loadClipboardHistoryEntries())
	if len(entries) > 0 {
		last := entries[len(entries)-1]
		if last.Text == text {
			if t, err := time.Parse(time.RFC3339, last.At); err == nil && time.Since(t) < 5*time.Second {
				return entries, nil
			}
		}
	}
	entries = append(entries, ClipboardEntry{
		ID:     fmt.Sprintf("clip-%d", time.Now().UnixNano()),
		Text:   text,
		Source: source,
		At:     time.Now().Format(time.RFC3339),
	})
	if err := saveClipboardHistoryEntries(entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// ClipboardHistory returns the current (auto-pruned) copy history, most
// recent last.
func (a *App) ClipboardHistory() []ClipboardEntry {
	a.clipboardMu.Lock()
	defer a.clipboardMu.Unlock()

	entries := loadClipboardHistoryEntries()
	pruned := pruneClipboardHistory(entries)
	if len(pruned) != len(entries) {
		_ = saveClipboardHistoryEntries(pruned)
	}
	return pruned
}

// DeleteClipboardEntry removes one entry by ID and returns the remaining
// history.
func (a *App) DeleteClipboardEntry(id string) ([]ClipboardEntry, error) {
	a.clipboardMu.Lock()
	defer a.clipboardMu.Unlock()

	entries := loadClipboardHistoryEntries()
	filtered := make([]ClipboardEntry, 0, len(entries))
	for _, e := range entries {
		if e.ID != id {
			filtered = append(filtered, e)
		}
	}
	if err := saveClipboardHistoryEntries(filtered); err != nil {
		return nil, err
	}
	return filtered, nil
}

// ClearClipboardHistory removes every entry.
func (a *App) ClearClipboardHistory() error {
	a.clipboardMu.Lock()
	defer a.clipboardMu.Unlock()
	return saveClipboardHistoryEntries(nil)
}

const clipboardPollInterval = 1 * time.Second

// pollSystemClipboard watches the macOS system pasteboard (via `pbpaste`,
// the same one every app's Cmd+C/Cmd+V goes through) so a copy made in ANY
// app — not just inside Thaloca's own window — shows up in the history.
// This is intentionally broad: whatever is copied anywhere on the Mac,
// including something sensitive from a password manager or terminal, gets
// written to ~/.thaloca/clipboard-history.json. Because of that, it's
// gated on GetClipboardHistoryEnabled/SetClipboardHistoryEnabled (Settings
// > Privacy) — checked every tick rather than only at startup, so toggling
// it off takes effect immediately. Defaults to on: the alternative (only
// recording copies made inside Thaloca's own webview) is a plain 'copy' DOM
// event listener, which cannot see clipboard activity in other apps at all.
func (a *App) pollSystemClipboard() {
	lastText, _ := readSystemClipboard() // seed with whatever's already on the clipboard so it isn't recorded as a "new" copy on startup
	lastChangeCount := pasteboardChangeCount()
	ticker := time.NewTicker(clipboardPollInterval)
	defer ticker.Stop()
	for range ticker.C {
		// NSPasteboard.changeCount only increments on an actual clipboard
		// change, so on the (overwhelmingly common) tick where nothing was
		// copied, this skips both the settings.json read below and spawning
		// pbpaste entirely, instead of paying for both every second.
		count := pasteboardChangeCount()
		if count == lastChangeCount {
			continue
		}
		lastChangeCount = count
		if !a.GetClipboardHistoryEnabled() {
			continue
		}
		text, err := readSystemClipboard()
		if err != nil || text == "" || text == lastText {
			continue
		}
		lastText = text
		_, _ = a.RecordClipboardCopy(text, "System clipboard")
	}
}

// GetClipboardHistoryEnabled reports whether pollSystemClipboard is allowed
// to record system-wide clipboard activity.
func (a *App) GetClipboardHistoryEnabled() bool {
	return loadUserSettings().ClipboardHistoryEnabled
}

// SetClipboardHistoryEnabled turns system-wide clipboard capture on or off.
func (a *App) SetClipboardHistoryEnabled(enabled bool) error {
	settings := loadUserSettings()
	settings.ClipboardHistoryEnabled = enabled
	return saveUserSettings(settings)
}

func readSystemClipboard() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "pbpaste").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
