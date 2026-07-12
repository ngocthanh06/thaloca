// Clipboard copy history: every explicit Copy action (via copyToClipboard)
// and every manual Cmd+C selection is recorded server-side
// (~/.thaloca/clipboard-history.json) with a 24h auto-expiry; this panel
// lists it and lets the user delete entries manually too.
import type { ClipboardEntry } from '../api'
import { api } from '../api'
import { escapeHTML, formatDate } from '../dom'

let entries: ClipboardEntry[] = []

export function initClipboardHistoryPanel(): void {
  if (document.getElementById('clipboard-root')) return
  const root = document.createElement('div')
  root.id = 'clipboard-root'
  root.className = 'settings-overlay'
  document.body.appendChild(root)

  root.addEventListener('mousedown', event => {
    if (event.target === root) closeClipboardHistoryPanel()
  })

  // Captures manual selections copied with Cmd+C (or the browser's own
  // context-menu Copy) — explicit "Copy" buttons elsewhere in the app go
  // through copyToClipboard() instead, which records the same way.
  document.addEventListener('copy', () => {
    const text = window.getSelection()?.toString() || ''
    if (text.trim()) void api.recordClipboardCopy(text, 'Manual selection')
  })
}

export async function openClipboardHistoryPanel(): Promise<void> {
  initClipboardHistoryPanel()
  entries = await api.clipboardHistory()
  render()
  document.getElementById('clipboard-root')?.classList.add('open')
}

export function closeClipboardHistoryPanel(): void {
  document.getElementById('clipboard-root')?.classList.remove('open')
}

function render(): void {
  const root = document.getElementById('clipboard-root')
  if (!root) return
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at))
  root.innerHTML = `
    <div class="settings-box">
      <header>
        <h2>Copy history</h2>
        <button class="btn-secondary" data-clipboard-close>Close</button>
      </header>
      <p class="resource-detail muted">Everything you copy in Thaloca, kept for 24 hours or until you delete it.</p>
      ${sorted.length ? `<div class="settings-buttons"><button class="btn-secondary" data-clipboard-clear>Clear all</button></div>` : ''}
      <div class="clipboard-list">
        ${sorted.length ? sorted.map(renderRow).join('') : '<div class="empty compact">Nothing copied yet.</div>'}
      </div>
    </div>`

  root.querySelector('[data-clipboard-close]')?.addEventListener('click', closeClipboardHistoryPanel)
  root.querySelector('[data-clipboard-clear]')?.addEventListener('click', () => void handleClear())
  root.querySelectorAll<HTMLButtonElement>('[data-clipboard-delete]').forEach(btn => {
    btn.addEventListener('click', () => void handleDelete(btn.dataset.clipboardDelete || ''))
  })
}

function renderRow(entry: ClipboardEntry): string {
  const preview = entry.text.length > 140 ? entry.text.slice(0, 140) + '…' : entry.text
  return `
    <div class="clipboard-row">
      <div class="clipboard-row-text">
        <code>${escapeHTML(preview)}</code>
        <span class="resource-detail muted">${entry.source ? escapeHTML(entry.source) + ' · ' : ''}${escapeHTML(formatDate(entry.at))}</span>
      </div>
      <button class="btn-secondary" data-clipboard-delete="${escapeHTML(entry.id)}">Delete</button>
    </div>`
}

async function handleDelete(id: string): Promise<void> {
  if (!id) return
  entries = await api.deleteClipboardEntry(id)
  render()
}

async function handleClear(): Promise<void> {
  await api.clearClipboardHistory()
  entries = []
  render()
}
