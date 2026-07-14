package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// terminalHistoryStore persists each server's terminal command history —
// keyed by server ID, most-recent command last — so it survives closing
// the terminal panel or quitting the app. This only ever stores what the
// user typed and pressed Enter on; Thaloca still never sees anything
// beyond that (the terminal itself is a raw PTY passthrough, see
// serverTerminal.go).
type terminalHistoryStore struct {
	History map[string][]string `json:"history"`
}

// terminalHistoryMaxPerServer bounds how many commands are kept per
// server so the file doesn't grow unbounded over a long-lived install.
const terminalHistoryMaxPerServer = 200

func terminalHistoryPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "terminal-history.json"), nil
}

func loadTerminalHistoryStore() terminalHistoryStore {
	path, err := terminalHistoryPath()
	if err != nil {
		return terminalHistoryStore{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return terminalHistoryStore{}
	}
	var store terminalHistoryStore
	if err := json.Unmarshal(data, &store); err != nil {
		return terminalHistoryStore{}
	}
	return store
}

func saveTerminalHistoryStore(store terminalHistoryStore) error {
	path, err := terminalHistoryPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// GetTerminalHistory returns this server's saved command history,
// oldest first (most-recent last) — the same order the frontend appends in.
func (a *App) GetTerminalHistory(serverID string) []string {
	return loadTerminalHistoryStore().History[serverID]
}

// AppendTerminalHistory records one completed command line for a server.
// The frontend calls this on a best-effort basis as it best-effort-tracks
// what the user typed in the PTY passthrough (see serverTerminal.ts) —
// it can't always be exact (e.g. the remote shell's own arrow-key history
// recall isn't visible to it), so this only appends non-empty lines and
// skips immediate consecutive repeats.
func (a *App) AppendTerminalHistory(serverID, command string) error {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil
	}
	store := loadTerminalHistoryStore()
	if store.History == nil {
		store.History = map[string][]string{}
	}
	list := store.History[serverID]
	if len(list) > 0 && list[len(list)-1] == command {
		return nil
	}
	list = append(list, command)
	if len(list) > terminalHistoryMaxPerServer {
		list = list[len(list)-terminalHistoryMaxPerServer:]
	}
	store.History[serverID] = list
	return saveTerminalHistoryStore(store)
}
