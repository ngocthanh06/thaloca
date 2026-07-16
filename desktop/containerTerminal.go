package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// containerTerminalSession tracks one live PTY-backed `docker exec` process
// backing an interactive container terminal.
type containerTerminalSession struct {
	id          string
	containerID string
	ptmx        *os.File
	cmd         *exec.Cmd
	cancel      context.CancelFunc
	finalize    sync.Once
	pumpOnce    sync.Once
}

func (a *App) startContainerTerminalPump(session *containerTerminalSession) {
	session.pumpOnce.Do(func() { go a.pumpContainerTerminal(session) })
}

// closeAllContainerTerminals kills every live container terminal session —
// used on app Shutdown so no `docker exec` subprocess survives a real quit.
func (a *App) closeAllContainerTerminals() {
	a.containerTerminalsMu.Lock()
	sessions := make([]*containerTerminalSession, 0, len(a.containerTerminals))
	for _, s := range a.containerTerminals {
		sessions = append(sessions, s)
	}
	a.containerTerminalsMu.Unlock()

	for _, s := range sessions {
		a.startContainerTerminalPump(s)
		s.cancel()
		s.ptmx.Close()
	}
}

// closeContainerTerminalFor closes any session already open for
// containerID. Each container keeps at most one live terminal at a time —
// unlike server terminals (capped at one app-wide), different containers'
// terminals run independently and concurrently, since a container's own
// long-running command (e.g. `npm run dev`) shouldn't be interrupted just
// because another container's terminal is opened.
func (a *App) closeContainerTerminalFor(containerID string) {
	a.containerTerminalsMu.Lock()
	var toClose []*containerTerminalSession
	for id, s := range a.containerTerminals {
		if s.containerID == containerID {
			toClose = append(toClose, s)
			delete(a.containerTerminals, id)
		}
	}
	a.containerTerminalsMu.Unlock()

	for _, s := range toClose {
		a.startContainerTerminalPump(s)
		s.cancel()
		s.ptmx.Close()
	}
}

// OpenContainerTerminal starts an interactive `docker exec` session inside
// containerID (bash when available, sh otherwise), wrapped in a local PTY,
// and returns a session ID immediately. Output streams via the
// "container-terminal:<sessionID>" event as it's produced; write keystrokes
// with WriteContainerTerminal and resize with ResizeContainerTerminal. Each
// container keeps at most one live terminal — opening a new one for the
// same container closes whatever was open for it before — but different
// containers' terminals stay open concurrently (see
// closeContainerTerminalFor).
func (a *App) OpenContainerTerminal(containerID string) (string, error) {
	containerID = strings.TrimSpace(containerID)
	if !containerIDPattern.MatchString(containerID) {
		return "", fmt.Errorf("invalid container id")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		return "", fmt.Errorf("docker not found")
	}

	a.closeContainerTerminalFor(containerID)

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "docker", "exec", "-it", containerID, "sh", "-c", "command -v bash >/dev/null && exec bash || exec sh")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		cancel()
		return "", fmt.Errorf("could not start terminal: %w", err)
	}

	session := &containerTerminalSession{
		id:          fmt.Sprintf("cterm-%s-%d", containerID, time.Now().UnixNano()),
		containerID: containerID,
		ptmx:        ptmx,
		cmd:         cmd,
		cancel:      cancel,
	}

	a.containerTerminalsMu.Lock()
	if a.containerTerminals == nil {
		a.containerTerminals = map[string]*containerTerminalSession{}
	}
	a.containerTerminals[session.id] = session
	a.containerTerminalsMu.Unlock()

	return session.id, nil
}

// ActivateContainerTerminal begins forwarding PTY output only after the
// frontend has installed both its data and closed-event listeners. Splitting
// creation from activation prevents a fast `docker exec` failure from
// emitting its only output/closed event before JavaScript knows the session
// ID and can subscribe to it.
func (a *App) ActivateContainerTerminal(sessionID string) error {
	session, ok := a.findContainerTerminalSession(sessionID)
	if !ok {
		return fmt.Errorf("unknown terminal session")
	}
	a.startContainerTerminalPump(session)
	return nil
}

// pumpContainerTerminal streams the session's PTY output to the frontend
// until it closes (shell exit, container stop, or CloseContainerTerminal),
// then finalizes the session exactly once.
func (a *App) pumpContainerTerminal(session *containerTerminalSession) {
	buf := make([]byte, 4096)
	for {
		n, err := session.ptmx.Read(buf)
		if n > 0 {
			// Output isn't guaranteed valid UTF-8 or aligned on a byte
			// boundary that survives JSON string encoding, so each chunk is
			// base64-encoded rather than emitted as a raw JS string (same
			// as pumpServerTerminal).
			wailsruntime.EventsEmit(a.ctx, "container-terminal:"+session.id, base64.StdEncoding.EncodeToString(buf[:n]))
		}
		if err != nil {
			break
		}
	}
	session.cancel()
	exitErr := session.cmd.Wait()
	a.finalizeContainerTerminal(session, exitErr)
}

// finalizeContainerTerminal removes the session and emits its closed event.
// Guarded by sync.Once since natural process exit (detected by
// pumpContainerTerminal) and an explicit CloseContainerTerminal call can
// race. Reuses ServerTerminalClosed (desktop/serverTerminal.go) since the
// payload shape is identical.
func (a *App) finalizeContainerTerminal(session *containerTerminalSession, exitErr error) {
	session.finalize.Do(func() {
		a.containerTerminalsMu.Lock()
		delete(a.containerTerminals, session.id)
		a.containerTerminalsMu.Unlock()

		payload := ServerTerminalClosed{}
		if exitErr != nil {
			payload.Error = exitErr.Error()
			if exitError, ok := exitErr.(*exec.ExitError); ok {
				payload.ExitCode = exitError.ExitCode()
			} else {
				payload.ExitCode = -1
			}
		}
		wailsruntime.EventsEmit(a.ctx, "container-terminal-closed:"+session.id, payload)
	})
}

func (a *App) findContainerTerminalSession(sessionID string) (*containerTerminalSession, bool) {
	a.containerTerminalsMu.Lock()
	defer a.containerTerminalsMu.Unlock()
	session, ok := a.containerTerminals[sessionID]
	return session, ok
}

// WriteContainerTerminal writes keystroke bytes (already UTF-8 encoded by
// xterm.js) to the session's PTY master.
func (a *App) WriteContainerTerminal(sessionID, data string) error {
	session, ok := a.findContainerTerminalSession(sessionID)
	if !ok {
		return fmt.Errorf("unknown terminal session")
	}
	_, err := session.ptmx.Write([]byte(data))
	return err
}

// ResizeContainerTerminal applies new terminal dimensions to the local PTY,
// which propagates SIGWINCH to `docker exec`, forwarding a window-change
// request to the shell inside the container.
func (a *App) ResizeContainerTerminal(sessionID string, cols, rows int) error {
	session, ok := a.findContainerTerminalSession(sessionID)
	if !ok {
		return fmt.Errorf("unknown terminal session")
	}
	return pty.Setsize(session.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

// CloseContainerTerminal ends a session. Idempotent — closing an
// already-closed or unknown session is not an error.
func (a *App) CloseContainerTerminal(sessionID string) error {
	session, ok := a.findContainerTerminalSession(sessionID)
	if !ok {
		return nil
	}
	a.startContainerTerminalPump(session)
	session.cancel()
	session.ptmx.Close()
	return nil
}
