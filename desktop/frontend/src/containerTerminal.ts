// Interactive PTY-backed container terminal: xterm.js on the frontend,
// wired to the Go OpenContainerTerminal/WriteContainerTerminal/
// ResizeContainerTerminal/CloseContainerTerminal bindings (desktop/
// containerTerminal.go) via Wails events — same push-event mechanism as
// ../serverTerminal.ts (see its doc comment for why request/response
// polling wouldn't work here).
//
// Unlike serverTerminal.ts, which keeps at most one live session app-wide,
// sessions here are keyed by container ID and multiple stay open at once:
// one container may be running a long-lived foreground command (e.g. `npm
// run dev`) while another container's terminal is opened for something
// else, and opening the second must not kill the first. Each container
// still caps at one live terminal — opening a new one for the same
// container replaces its previous session, mirroring the backend's own
// per-container cap (see closeContainerTerminalFor).
//
// Same re-parenting trick as reattachServerTerminal: the view only renders
// an empty mount point per container row (data-container-terminal-mount),
// and reattachContainerTerminal moves the existing xterm element into
// whatever mount point the latest render produced, preserving scrollback
// instead of recreating the session. No command-history suggestion bar here
// (unlike servers) — that feature is keyed by a saved server's stable ID;
// container IDs churn every time a container is recreated, so persisting
// history for them wouldn't be useful.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EventsOn } from '../wailsjs/runtime/runtime'
import { api } from './api'
import { terminalTheme } from './terminalTheme'

export type ContainerTerminalStatus = 'connecting' | 'open' | 'closed'

interface ActiveContainerTerminal {
  containerId: string
  sessionId: string
  term: Terminal
  fitAddon: FitAddon
  resizeObserver: ResizeObserver
  unsubData: () => void
  unsubClosed: () => void
  closed: boolean
  wrapper: HTMLDivElement
}

const sessions = new Map<string, ActiveContainerTerminal>()

export function activeContainerTerminalId(containerId: string): string | null {
  return sessions.get(containerId)?.sessionId ?? null
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function observeResize(session: ActiveContainerTerminal, mountEl: HTMLElement): ResizeObserver {
  const resizeObserver = new ResizeObserver(() => {
    if (session.closed) return
    session.fitAddon.fit()
    void api.resizeContainerTerminal(session.sessionId, session.term.cols, session.term.rows)
  })
  resizeObserver.observe(mountEl)
  return resizeObserver
}

function disposeSession(session: ActiveContainerTerminal): void {
  session.closed = true
  session.resizeObserver.disconnect()
  session.unsubData()
  session.unsubClosed()
  session.term.dispose()
  if (sessions.get(session.containerId) === session) sessions.delete(session.containerId)
}

// Ends containerId's session (if any), both locally and on the backend.
// Idempotent — calling this with nothing open for containerId is a no-op.
export async function closeContainerTerminal(containerId: string): Promise<void> {
  const session = sessions.get(containerId)
  if (!session) return
  const sessionId = session.sessionId
  disposeSession(session)
  try {
    await api.closeContainerTerminal(sessionId)
  } catch {
    // Best-effort: the session may already be gone on the backend.
  }
}

// Opens a new terminal session for `containerId`, mounting xterm.js into
// `mountEl`. `onStatus` is called as the session's connection state changes
// so the caller can update its own chrome (toolbar/status line).
export async function openContainerTerminal(
  containerId: string,
  mountEl: HTMLElement,
  onStatus: (status: ContainerTerminalStatus, detail?: string) => void,
): Promise<void> {
  await closeContainerTerminal(containerId)

  onStatus('connecting')
  let sessionId: string
  try {
    sessionId = await api.openContainerTerminal(containerId)
  } catch (error) {
    onStatus('closed', String(error))
    return
  }

  const term = new Terminal({
    convertEol: true,
    fontSize: 13,
    cursorBlink: true,
    theme: terminalTheme,
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  const wrapper = document.createElement('div')
  wrapper.className = 'terminal-session-wrapper'
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'terminal-xterm-container'
  wrapper.appendChild(xtermContainer)
  mountEl.appendChild(wrapper)

  term.open(xtermContainer)
  fitAddon.fit()

  const session: ActiveContainerTerminal = {
    containerId,
    sessionId,
    term,
    fitAddon,
    closed: false,
    resizeObserver: null as unknown as ResizeObserver,
    unsubData: () => {},
    unsubClosed: () => {},
    wrapper,
  }
  session.resizeObserver = observeResize(session, mountEl)
  sessions.set(containerId, session)

  session.unsubData = EventsOn(`container-terminal:${sessionId}`, (chunk: string) => {
    if (session.closed) return
    term.write(base64ToUint8Array(chunk))
  })
  session.unsubClosed = EventsOn(`container-terminal-closed:${sessionId}`, (payload: { exit_code: number; error?: string }) => {
    if (session.closed) return
    disposeSession(session)
    onStatus('closed', payload?.error)
  })

  term.onData(data => {
    if (session.closed) return
    void api.writeContainerTerminal(sessionId, data)
  })

  try {
    // The backend deliberately waits here before reading/emitting PTY data,
    // so even an immediate docker-exec failure reaches the listeners above.
    await api.activateContainerTerminal(sessionId)
    if (session.closed) return
    onStatus('open')
    await api.resizeContainerTerminal(sessionId, term.cols, term.rows)
  } catch (error) {
    onStatus('closed', String(error))
    await closeContainerTerminal(containerId)
  }
}

// Re-parents containerId's session DOM into a freshly rendered mount point,
// since the surrounding view stamps its innerHTML from scratch on every
// state change. A no-op if there's no active session for containerId, or if
// it's already attached to this exact element.
export function reattachContainerTerminal(containerId: string, mountEl: HTMLElement): void {
  const session = sessions.get(containerId)
  if (!session || session.closed) return
  if (session.wrapper.parentElement === mountEl) return
  mountEl.appendChild(session.wrapper)
  session.resizeObserver.disconnect()
  session.resizeObserver = observeResize(session, mountEl)
  session.fitAddon.fit()
}

// Closes every live container terminal session — used when the Runtime tab
// itself is torn down (e.g. navigating away), mirroring how servers.ts
// closes its own terminal on comparable teardown paths.
export async function closeAllContainerTerminals(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeContainerTerminal))
}
