package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// terminalSession tracks one live PTY-backed `ssh -tt` process backing an
// interactive server terminal.
type terminalSession struct {
	id       string
	serverID string
	ptmx     *os.File
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	finalize sync.Once
}

// ServerTerminalClosed is the payload of the "server-terminal-closed:<id>"
// event, emitted exactly once when a session ends (remote exit/disconnect,
// or an explicit CloseServerTerminal call).
type ServerTerminalClosed struct {
	ExitCode int    `json:"exit_code"`
	Error    string `json:"error,omitempty"`
}

// closeAllServerTerminals kills every live terminal session. Used both to
// cap the app at one live session at a time (a new OpenServerTerminal call
// closes whatever was open before) and on app Shutdown, so no `ssh`
// subprocess survives a real quit.
func (a *App) closeAllServerTerminals() {
	a.terminalsMu.Lock()
	sessions := make([]*terminalSession, 0, len(a.terminals))
	for _, s := range a.terminals {
		sessions = append(sessions, s)
	}
	a.terminalsMu.Unlock()

	for _, s := range sessions {
		s.cancel()
		s.ptmx.Close()
	}
}

// OpenServerTerminal starts an interactive `ssh -tt` session for the given
// server, wrapped in a local PTY, and returns a session ID immediately.
// Output streams via the "server-terminal:<sessionID>" event as it's
// produced; write keystrokes with WriteServerTerminal and resize with
// ResizeServerTerminal. Only one terminal session is kept alive app-wide —
// opening a new one closes whatever was open before.
func (a *App) OpenServerTerminal(serverID string) (string, error) {
	conn, ok := findServer(serverID)
	if !ok {
		return "", fmt.Errorf("unknown server")
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return "", fmt.Errorf("ssh is not installed")
	}

	a.closeAllServerTerminals()

	ctx, cancel := context.WithCancel(context.Background())
	args := append([]string{"-tt"}, sshBaseArgs(conn)...)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	ptmx, err := pty.Start(cmd)
	if err != nil {
		cancel()
		return "", fmt.Errorf("could not start terminal: %w", err)
	}

	session := &terminalSession{
		id:       fmt.Sprintf("term-%s-%d", conn.ID, time.Now().UnixNano()),
		serverID: serverID,
		ptmx:     ptmx,
		cmd:      cmd,
		cancel:   cancel,
	}

	a.terminalsMu.Lock()
	if a.terminals == nil {
		a.terminals = map[string]*terminalSession{}
	}
	a.terminals[session.id] = session
	a.terminalsMu.Unlock()

	go a.pumpServerTerminal(session)

	return session.id, nil
}

// pumpServerTerminal streams the session's PTY output to the frontend until
// it closes (remote exit/disconnect, or CloseServerTerminal), then finalizes
// the session exactly once.
func (a *App) pumpServerTerminal(session *terminalSession) {
	buf := make([]byte, 4096)
	for {
		n, err := session.ptmx.Read(buf)
		if n > 0 {
			// Output isn't guaranteed valid UTF-8 or aligned on a byte
			// boundary that survives JSON string encoding, so each chunk
			// is base64-encoded rather than emitted as a raw JS string.
			wailsruntime.EventsEmit(a.ctx, "server-terminal:"+session.id, base64.StdEncoding.EncodeToString(buf[:n]))
		}
		if err != nil {
			break
		}
	}
	session.cancel()
	exitErr := session.cmd.Wait()
	a.finalizeServerTerminal(session, exitErr)
}

// finalizeServerTerminal removes the session and emits its closed event.
// Guarded by sync.Once since natural process exit (detected by
// pumpServerTerminal) and an explicit CloseServerTerminal call can race.
func (a *App) finalizeServerTerminal(session *terminalSession, exitErr error) {
	session.finalize.Do(func() {
		a.terminalsMu.Lock()
		delete(a.terminals, session.id)
		a.terminalsMu.Unlock()

		payload := ServerTerminalClosed{}
		if exitErr != nil {
			payload.Error = exitErr.Error()
			if exitError, ok := exitErr.(*exec.ExitError); ok {
				payload.ExitCode = exitError.ExitCode()
			} else {
				payload.ExitCode = -1
			}
		}
		wailsruntime.EventsEmit(a.ctx, "server-terminal-closed:"+session.id, payload)
	})
}

func (a *App) findTerminalSession(sessionID string) (*terminalSession, bool) {
	a.terminalsMu.Lock()
	defer a.terminalsMu.Unlock()
	session, ok := a.terminals[sessionID]
	return session, ok
}

// WriteServerTerminal writes keystroke bytes (already UTF-8 encoded by
// xterm.js) to the session's PTY master.
func (a *App) WriteServerTerminal(sessionID, data string) error {
	session, ok := a.findTerminalSession(sessionID)
	if !ok {
		return fmt.Errorf("unknown terminal session")
	}
	_, err := session.ptmx.Write([]byte(data))
	return err
}

// ResizeServerTerminal applies new terminal dimensions to the local PTY,
// which propagates SIGWINCH to `ssh`, forwarding a window-change request to
// the remote shell.
func (a *App) ResizeServerTerminal(sessionID string, cols, rows int) error {
	session, ok := a.findTerminalSession(sessionID)
	if !ok {
		return fmt.Errorf("unknown terminal session")
	}
	return pty.Setsize(session.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

// CloseServerTerminal ends a session. Idempotent — closing an
// already-closed or unknown session is not an error.
func (a *App) CloseServerTerminal(sessionID string) error {
	session, ok := a.findTerminalSession(sessionID)
	if !ok {
		return nil
	}
	session.cancel()
	session.ptmx.Close()
	return nil
}
