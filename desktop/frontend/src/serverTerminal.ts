// Interactive PTY-backed server terminal: xterm.js on the frontend, wired
// to the Go OpenServerTerminal/WriteServerTerminal/ResizeServerTerminal/
// CloseServerTerminal bindings (desktop/serverTerminal.go) via Wails events
// for streaming output (the app's first use of push events — everything
// else is request/response, but ~700ms poll latency would make typing and
// interactive programs like vim/htop feel broken here).
//
// The rest of this app re-renders a view's whole innerHTML from state on
// every change, which would tear down and recreate the terminal's DOM on
// every unrelated re-render. Instead, the Terminal instance and its DOM
// element live outside that render cycle: the view only renders an empty
// mount point (data-server-terminal-mount), and reattachServerTerminal
// moves the existing xterm element into whatever mount point the latest
// render produced, preserving scrollback instead of recreating the session.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { EventsOn } from '../wailsjs/runtime/runtime'
import { api } from './api'

export type ServerTerminalStatus = 'connecting' | 'open' | 'closed'

interface ActiveTerminal {
  serverId: string
  sessionId: string
  term: Terminal
  fitAddon: FitAddon
  resizeObserver: ResizeObserver
  unsubData: () => void
  unsubClosed: () => void
  closed: boolean
}

// Only one live terminal session is kept app-wide (matches the backend's
// own one-session cap) — opening a new one closes whatever was open before.
let active: ActiveTerminal | null = null

export function activeServerTerminalId(serverId: string): string | null {
  return active && active.serverId === serverId ? active.sessionId : null
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function observeResize(session: ActiveTerminal, mountEl: HTMLElement): ResizeObserver {
  const resizeObserver = new ResizeObserver(() => {
    if (session.closed) return
    session.fitAddon.fit()
    void api.resizeServerTerminal(session.sessionId, session.term.cols, session.term.rows)
  })
  resizeObserver.observe(mountEl)
  return resizeObserver
}

function disposeActive(): void {
  if (!active) return
  active.closed = true
  active.resizeObserver.disconnect()
  active.unsubData()
  active.unsubClosed()
  active.term.dispose()
  active = null
}

// Ends the current session (if any), both locally and on the backend.
// Idempotent — calling this with nothing open is a no-op.
export async function closeServerTerminal(): Promise<void> {
  if (!active) return
  const sessionId = active.sessionId
  disposeActive()
  try {
    await api.closeServerTerminal(sessionId)
  } catch {
    // Best-effort: the session may already be gone on the backend.
  }
}

// Opens a new terminal session for `serverId`, mounting xterm.js into
// `mountEl`. `onStatus` is called as the session's connection state
// changes so the caller can update its own chrome (toolbar/status line).
export async function openServerTerminal(
  serverId: string,
  mountEl: HTMLElement,
  onStatus: (status: ServerTerminalStatus, detail?: string) => void,
): Promise<void> {
  await closeServerTerminal()

  onStatus('connecting')
  let sessionId: string
  try {
    sessionId = await api.openServerTerminal(serverId)
  } catch (error) {
    onStatus('closed', String(error))
    return
  }

  const term = new Terminal({
    convertEol: true,
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0a0e17' },
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(mountEl)
  fitAddon.fit()

  const session: ActiveTerminal = {
    serverId,
    sessionId,
    term,
    fitAddon,
    closed: false,
    resizeObserver: null as unknown as ResizeObserver,
    unsubData: () => {},
    unsubClosed: () => {},
  }
  session.resizeObserver = observeResize(session, mountEl)
  active = session

  session.unsubData = EventsOn(`server-terminal:${sessionId}`, (chunk: string) => {
    if (session.closed) return
    term.write(base64ToUint8Array(chunk))
  })
  session.unsubClosed = EventsOn(`server-terminal-closed:${sessionId}`, (payload: { exit_code: number; error?: string }) => {
    if (session.closed) return
    onStatus('closed', payload?.error)
  })

  term.onData(data => {
    if (session.closed) return
    void api.writeServerTerminal(sessionId, data)
  })

  onStatus('open')
  await api.resizeServerTerminal(sessionId, term.cols, term.rows)
}

// Re-parents the active session's terminal DOM into a freshly rendered
// mount point, since the surrounding view stamps its innerHTML from scratch
// on every state change. A no-op if there's no active session for
// `serverId`, or if it's already attached to this exact element.
export function reattachServerTerminal(serverId: string, mountEl: HTMLElement): void {
  if (!active || active.serverId !== serverId || active.closed) return
  if (active.term.element?.parentElement === mountEl) return
  mountEl.appendChild(active.term.element!)
  active.resizeObserver.disconnect()
  active.resizeObserver = observeResize(active, mountEl)
  active.fitAddon.fit()
}
