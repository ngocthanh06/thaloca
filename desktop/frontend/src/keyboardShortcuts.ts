// User-configurable keyboard shortcuts to jump straight to a tab. A
// frontend-only preference (same pattern as theme.ts and Source Control's
// pinned-repos set), kept in localStorage rather than a new Go-backed
// setting. Assigned from Settings by focusing a shortcut field and
// pressing the desired key combo (see components/settingsPanel.ts).

export interface ShortcutTarget { id: string; label: string }

export const SHORTCUT_TARGETS: ShortcutTarget[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'source', label: 'Source Control' },
  { id: 'resources', label: 'Resources' },
  { id: 'tools', label: 'Tools' },
  { id: 'servers', label: 'Servers' },
  { id: 'logs', label: 'Logs' },
  { id: 'security', label: 'Security' },
  { id: 'documents', label: 'Documents' },
  { id: 'captures', label: 'Captures' },
  { id: 'ai-monitor', label: 'AI Services' },
]

const STORAGE_KEY = 'thaloca-keyboard-shortcuts'

// A combo is normalized as e.g. "meta+shift+1" (modifiers in a fixed
// order, lowercase) so a stored string always compares equal to one
// derived live from a keydown event, regardless of press order. At least
// one of ctrl/meta/alt is required — a bare letter or Shift+letter is
// indistinguishable from normal typing in any of the app's many text
// inputs, so it's rejected rather than risk hijacking that.
export function comboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase()
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return null
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.metaKey) parts.push('meta')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

export function formatCombo(combo: string): string {
  return combo.split('+').map(part => {
    switch (part) {
      case 'ctrl': return 'Ctrl'
      case 'meta': return '⌘'
      case 'alt': return '⌥'
      case 'shift': return '⇧'
      default: return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
    }
  }).join('+')
}

export function getShortcuts(): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}

const VALID_MODIFIERS = new Set(['ctrl', 'meta', 'alt', 'shift'])

// Mirrors what comboFromEvent can actually produce — at least one of
// ctrl/meta/alt, only known modifier tokens, and a non-modifier key last.
function isValidCombo(combo: unknown): combo is string {
  if (typeof combo !== 'string' || !combo) return false
  const parts = combo.split('+')
  if (parts.length < 2) return false
  const key = parts[parts.length - 1]
  if (!key || VALID_MODIFIERS.has(key)) return false
  const modifiers = parts.slice(0, -1)
  if (!modifiers.every(mod => VALID_MODIFIERS.has(mod))) return false
  return modifiers.some(mod => mod === 'ctrl' || mod === 'meta' || mod === 'alt')
}

// Exposed for config export/import (backup.go) — shortcuts live in
// localStorage, not a Go-side file, so the backend needs them handed
// in/out. A hand-edited backup file could reference a view that no longer
// exists, an unparseable combo, or the same combo assigned to more than
// one view (matchShortcut would then always resolve to whichever one
// happens to come first) — silently drop anything that doesn't match a
// known target id or the comboFromEvent format, and keep only the first
// target seen for any given combo.
export function setShortcuts(shortcuts: Record<string, string>): void {
  const known = new Set(SHORTCUT_TARGETS.map(target => target.id))
  const usedCombos = new Set<string>()
  const filtered: Record<string, string> = {}
  for (const [id, combo] of Object.entries(shortcuts || {})) {
    if (!known.has(id) || !isValidCombo(combo) || usedCombos.has(combo)) continue
    filtered[id] = combo
    usedCombos.add(combo)
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

// Assigning a combo already bound to another target un-binds it there
// first — a combo can only ever point at one place.
export function setShortcut(id: string, combo: string | null): void {
  const shortcuts = getShortcuts()
  for (const key of Object.keys(shortcuts)) {
    if (shortcuts[key] === combo) delete shortcuts[key]
  }
  if (combo) shortcuts[id] = combo
  else delete shortcuts[id]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts))
}

// Called from the app-wide keydown listener in main.ts — returns the view
// id bound to this event's combo, if any.
export function matchShortcut(event: KeyboardEvent): string | null {
  const combo = comboFromEvent(event)
  if (!combo) return null
  const shortcuts = getShortcuts()
  const entry = Object.entries(shortcuts).find(([, value]) => value === combo)
  return entry ? entry[0] : null
}
