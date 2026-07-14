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
//
// Command history + suggestions: since this is a raw PTY passthrough (every
// keystroke forwarded as-is), Thaloca can't ask the remote shell what the
// current line is — it only best-effort-reconstructs it client-side from
// the same keystrokes (see trackLineBuffer), which is why anything it can't
// interpret (arrow keys, Ctrl+C/U, pastes with escape sequences) just
// resets that buffer instead of guessing. Completed lines are persisted per
// server via GetTerminalHistory/AppendTerminalHistory (desktop/
// terminalHistory.go) and shown as clickable suggestion chips.
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
  wrapper: HTMLDivElement
  suggestBar: HTMLDivElement
  // Best-effort record of the in-progress line, rebuilt from raw
  // keystrokes (see trackLineBuffer) — used only to power the history
  // suggestion bar and to know what to save on Enter. It can't always be
  // exact: escape sequences (arrow keys triggering the remote shell's own
  // history recall, etc.) aren't something a passthrough can interpret,
  // so those reset it to empty rather than risk showing something wrong.
  history: string[]
  lineBuffer: string
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

  let history: string[] = []
  try {
    history = await api.getTerminalHistory(serverId)
  } catch {
    // Best-effort — an empty suggestion list just means no history yet.
  }

  const term = new Terminal({
    convertEol: true,
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0a0e17' },
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)

  const wrapper = document.createElement('div')
  wrapper.className = 'terminal-session-wrapper'
  const suggestBar = document.createElement('div')
  suggestBar.className = 'terminal-suggest-bar'
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'terminal-xterm-container'
  wrapper.appendChild(suggestBar)
  wrapper.appendChild(xtermContainer)
  mountEl.appendChild(wrapper)

  term.open(xtermContainer)
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
    wrapper,
    suggestBar,
    history,
    lineBuffer: '',
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
    trackLineBuffer(session, data)
    void api.writeServerTerminal(sessionId, data)
  })

  onStatus('open')
  await api.resizeServerTerminal(sessionId, term.cols, term.rows)
}

// Rebuilds the best-effort in-progress line from raw PTY input so the
// suggestion bar and history-on-Enter have something to work with. See the
// ActiveTerminal.lineBuffer doc comment for why this is inherently
// approximate — anything it can't interpret just resets to empty.
function trackLineBuffer(session: ActiveTerminal, data: string): void {
  if (data.length !== 1) {
    if (data.startsWith('\x1b')) {
      // An escape sequence (arrow keys, etc.) — the remote shell may be
      // doing its own history recall/line editing we can't mirror.
      session.lineBuffer = ''
    } else {
      // A multi-char chunk with no escape prefix is a paste. Best-effort:
      // treat each newline-separated piece as a completed command except
      // the last, which becomes the new in-progress line.
      const parts = data.split(/\r\n|\r|\n/)
      session.lineBuffer += parts[0]
      for (let i = 1; i < parts.length; i++) {
        commitLineBuffer(session)
        session.lineBuffer = parts[i]
      }
    }
    updateSuggestions(session)
    return
  }

  if (data === '\r' || data === '\n') {
    commitLineBuffer(session)
    session.lineBuffer = ''
  } else if (data === '\x7f' || data === '\b') {
    session.lineBuffer = session.lineBuffer.slice(0, -1)
  } else {
    const code = data.charCodeAt(0)
    if (code >= 0x20 && code < 0x7f) {
      session.lineBuffer += data
    } else {
      // Ctrl+C, Ctrl+U, Escape, or any other control byte — can't track
      // what the line looks like after this, so drop the buffer instead
      // of risking a stale/wrong suggestion.
      session.lineBuffer = ''
    }
  }
  updateSuggestions(session)
}

function commitLineBuffer(session: ActiveTerminal): void {
  const command = session.lineBuffer.trim()
  if (!command) return
  session.history.push(command)
  void api.appendTerminalHistory(session.serverId, command)
}

function updateSuggestions(session: ActiveTerminal): void {
  const buf = session.lineBuffer.trim()
  session.suggestBar.innerHTML = ''
  if (!buf) {
    session.suggestBar.classList.remove('visible')
    return
  }
  const seen = new Set<string>()
  const matches: string[] = []
  for (let i = session.history.length - 1; i >= 0 && matches.length < 6; i--) {
    const command = session.history[i]
    if (command === buf || seen.has(command) || !command.startsWith(buf)) continue
    seen.add(command)
    matches.push(command)
  }
  if (!matches.length) {
    session.suggestBar.classList.remove('visible')
    return
  }
  session.suggestBar.classList.add('visible')
  for (const command of matches) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'terminal-suggest-chip'
    chip.textContent = command
    // mousedown (not click) + preventDefault so the terminal never loses
    // focus to this button in between.
    chip.addEventListener('mousedown', event => {
      event.preventDefault()
      acceptSuggestion(session, command)
    })
    session.suggestBar.appendChild(chip)
  }
}

function acceptSuggestion(session: ActiveTerminal, command: string): void {
  const backspaces = '\x7f'.repeat(session.lineBuffer.length)
  session.lineBuffer = command
  void api.writeServerTerminal(session.sessionId, backspaces + command)
  updateSuggestions(session)
}

// Re-parents the active session's terminal DOM into a freshly rendered
// mount point, since the surrounding view stamps its innerHTML from scratch
// on every state change. A no-op if there's no active session for
// `serverId`, or if it's already attached to this exact element.
export function reattachServerTerminal(serverId: string, mountEl: HTMLElement): void {
  if (!active || active.serverId !== serverId || active.closed) return
  if (active.wrapper.parentElement === mountEl) return
  mountEl.appendChild(active.wrapper)
  active.resizeObserver.disconnect()
  active.resizeObserver = observeResize(active, mountEl)
  active.fitAddon.fit()
}
