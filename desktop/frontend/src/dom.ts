// Small formatting/escaping helpers shared by main.ts and the newer view
// modules (overview/serviceInspector/commandPalette). Kept in their
// own module so those views don't need to import from main.ts (which would
// create a circular import back into the modules main.ts itself imports).
import { t } from './i18n'

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
  if (el) el.innerHTML = `<div class="loading">${t('Loading...')}</div>`
}

// App-wide loading bar (see #global-loading-bar in main.ts's template) —
// unlike showLoading above, which only replaces one tab's own content,
// this is visible regardless of which tab is active, so a Refresh click
// gives some feedback even when nothing on the current tab changes.
// Mimics the familiar "page load" progress bar: jumps most of the way
// immediately (nprogressLoadingBarHideTimer clears any still-hiding
// previous run), creeps toward 90% while the real work is unknown-length,
// then snaps to 100% and fades out once stopGlobalLoading is called.
let loadingBarHideTimer: number | undefined

export function startGlobalLoading(): void {
  const bar = document.getElementById('global-loading-bar')
  if (!bar) return
  window.clearTimeout(loadingBarHideTimer)
  bar.style.transition = 'none'
  bar.style.opacity = '1'
  bar.style.width = '0%'
  void bar.offsetWidth // force reflow so the 0% start commits before animating
  bar.style.transition = 'width 4s cubic-bezier(0.1, 0.7, 1, 0.1)'
  bar.style.width = '85%'
}

export function stopGlobalLoading(): void {
  const bar = document.getElementById('global-loading-bar')
  if (!bar) return
  bar.style.transition = 'width 200ms ease'
  bar.style.width = '100%'
  window.clearTimeout(loadingBarHideTimer)
  loadingBarHideTimer = window.setTimeout(() => {
    bar.style.transition = 'opacity 300ms ease'
    bar.style.opacity = '0'
    loadingBarHideTimer = window.setTimeout(() => {
      bar.style.transition = 'none'
      bar.style.width = '0%'
    }, 320)
  }, 200)
}

// #splash-screen is static markup in index.html (visible from the very
// first paint, before renderApp/loadAll even run) — this hides it once the
// app's first data load finishes. Safe to call more than once: a second
// call just finds no element (already removed) and no-ops, so main.ts can
// call it from loadAll()'s finally block unconditionally, including on
// later manual Refresh clicks, without needing its own "is this the first
// load" bookkeeping.
export function hideSplashScreen(): void {
  const splash = document.getElementById('splash-screen')
  if (!splash) return
  splash.classList.add('hidden')
  window.setTimeout(() => splash.remove(), 320)
}

export function showError(message: string): void {
  const banner = document.getElementById('error-banner')!
  banner.textContent = message
  banner.classList.add('visible')
  setTimeout(() => banner.classList.remove('visible'), 5000)
}
