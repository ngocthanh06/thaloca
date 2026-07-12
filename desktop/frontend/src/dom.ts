// Small formatting/escaping helpers shared by main.ts and the newer view
// modules (overview/serviceInspector/commandPalette). Kept in their
// own module so those views don't need to import from main.ts (which would
// create a circular import back into the modules main.ts itself imports).

export function escapeHTML(str: unknown): string {
  const el = document.createElement('div')
  el.textContent = String(str ?? '')
  // textContent escaping covers & < > but not quotes, and these strings
  // are also interpolated into HTML attributes.
  return el.innerHTML.replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function formatBytes(size: number): string {
  if (!size) return ''
  if (size < 1024) return `${Math.round(size)} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function formatDuration(ns: number): string {
  const ms = Math.round(ns / 1_000_000)
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.round(s / 60)}m`
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function getStatusClass(state: string): string {
  return `status-${state}`
}

export function getSourceBadgeClass(source: string): string {
  return `source-badge ${source}`
}

// Pure so view modules can filter their own lists without importing
// main.ts's mutable searchQuery directly (same circular-import reason as
// the rest of this file) — callers pass the current query explicitly.
export function matchesSearch(query: string, ...parts: (string | number | undefined | null)[]): boolean {
  if (!query) return true
  return parts.some(part => String(part ?? '').toLowerCase().includes(query))
}

export function showLoading(elementId: string): void {
  const el = document.getElementById(elementId)
  if (el) el.innerHTML = '<div class="loading">Loading...</div>'
}

export function showError(message: string): void {
  const banner = document.getElementById('error-banner')!
  banner.textContent = message
  banner.classList.add('visible')
  setTimeout(() => banner.classList.remove('visible'), 5000)
}
