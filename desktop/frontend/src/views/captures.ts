import { api, type CapturesSnapshot } from '../api'
import { escapeHTML, formatBytes, matchesSearch, showError, showSuccess } from '../dom'
import { EventsOn } from '../../wailsjs/runtime/runtime'
import { openCaptureEditor } from './captureEditor'
import { copyToClipboard } from '../clipboard'

let snapshot: CapturesSnapshot | null = null
let initialized = false
let renamingPath: string | null = null
let busy = false
// path → data URI ('' = generation failed, keep the placeholder glyph)
const thumbs = new Map<string, string>()
let thumbsLoading = false
let searchQuery = ''
type KindFilter = 'all' | 'image' | 'video'
let kindFilter: KindFilter = 'all'
type DateFilter = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom'
let dateFilter: DateFilter = 'all'
// yyyy-mm-dd, as produced by <input type="date"> — '' means unbounded on
// that side, so picking just "from" means "from that day onward" and vice
// versa.
let customDateFrom = ''
let customDateTo = ''

// Boundaries are all local-midnight based (not "last 24h") so "Today" means
// the same thing a screenshot's Finder date does, not a rolling window.
function matchesDateFilter(modifiedAt: number): boolean {
  if (dateFilter === 'all') return true
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const dayMs = 86400000
  const ts = modifiedAt * 1000
  switch (dateFilter) {
    case 'today': return ts >= startOfToday.getTime()
    case 'yesterday': return ts >= startOfToday.getTime() - dayMs && ts < startOfToday.getTime()
    case 'week': return ts >= startOfToday.getTime() - 6 * dayMs
    case 'month': return ts >= startOfToday.getTime() - 29 * dayMs
    case 'custom': {
      if (customDateFrom && ts < new Date(`${customDateFrom}T00:00:00`).getTime()) return false
      if (customDateTo && ts >= new Date(`${customDateTo}T00:00:00`).getTime() + dayMs) return false
      return true
    }
  }
}

function visibleCaptures(state: CapturesSnapshot): CapturesSnapshot['captures'] {
  return state.captures.filter(capture =>
    (kindFilter === 'all' || capture.kind === kindFilter) &&
    matchesDateFilter(capture.modified_at) &&
    matchesSearch(searchQuery, capture.name))
}

function emptySnapshot(): CapturesSnapshot {
  return { location: '', dedicated_folder: '', using_dedicated: false, captures: [] }
}

function relativeTime(unixSeconds: number): string {
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

function editableInApp(name: string): boolean {
  return /\.(png|jpe?g)$/i.test(name)
}

function renderThumb(capture: CapturesSnapshot['captures'][number]): string {
  const uri = thumbs.get(capture.path)
  const badge = capture.kind === 'video' ? '<span class="capture-kind-badge">▶</span>' : ''
  if (uri) return `<img class="capture-thumb-img" data-thumb-for="${escapeHTML(capture.path)}" src="${uri}" alt="">${badge}`
  const glyph = capture.kind === 'video'
    ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>'
    : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-4.5-4.5L9 19"/></svg>'
  return `<span class="capture-thumb-placeholder" data-thumb-for="${escapeHTML(capture.path)}">${glyph}</span>${badge}`
}

function renderName(capture: CapturesSnapshot['captures'][number]): string {
  if (renamingPath !== capture.path) {
    return `<strong class="capture-name" title="${escapeHTML(capture.name)}">${escapeHTML(capture.name)}</strong>`
  }
  const { stem, ext } = splitName(capture.name)
  return `<span class="capture-rename"><input id="capture-rename-input" value="${escapeHTML(stem)}" autocomplete="off" spellcheck="false"><span class="capture-rename-ext">${escapeHTML(ext)}</span><button class="btn-icon" data-capture-rename-confirm="${escapeHTML(capture.path)}" title="Rename">✓</button><button class="btn-icon" data-capture-rename-cancel="1" title="Cancel">×</button></span>`
}

function renderCard(capture: CapturesSnapshot['captures'][number]): string {
  const path = escapeHTML(capture.path)
  return `<article class="capture-card">
    <button class="capture-thumb" data-capture-open="${path}" title="Open">${renderThumb(capture)}</button>
    <div class="capture-copy">${renderName(capture)}<small>${formatBytes(capture.size)} · ${escapeHTML(relativeTime(capture.modified_at))}</small></div>
    <div class="capture-actions">
      <details class="capture-row-menu">
        <summary class="btn-icon-sm" title="More actions"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></summary>
        <div class="capture-row-menu-panel">
          <button data-capture-copy="${path}">Copy</button>
          ${capture.kind === 'image' ? `<button data-capture-ocr="${path}">Extract text (OCR)</button>` : ''}
          <button data-capture-edit="${path}">${capture.kind === 'video' ? 'Open to trim' : 'Edit'}</button>
          <button data-capture-rename="${path}">Rename</button>
          <button data-capture-reveal="${path}">Show in Finder</button>
          <button class="danger" data-capture-delete="${path}">Move to Trash</button>
        </div>
      </details>
    </div>
  </article>`
}

function renderKindFilter(): string {
  const options: { value: KindFilter; label: string }[] = [
    { value: 'all', label: 'All' }, { value: 'image', label: 'Screenshots' }, { value: 'video', label: 'Recordings' },
  ]
  return options.map(o => `<button class="subtab${kindFilter === o.value ? ' active' : ''}" data-capture-filter="${o.value}">${o.label}</button>`).join('')
}

function renderDateFilter(): string {
  const options: { value: DateFilter; label: string }[] = [
    { value: 'all', label: 'Any date' }, { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' },
    { value: 'week', label: 'Last 7 days' }, { value: 'month', label: 'Last 30 days' }, { value: 'custom', label: 'Custom range…' },
  ]
  const select = `<select id="captures-date-filter" class="search-input capture-date-select">
    ${options.map(o => `<option value="${o.value}" ${dateFilter === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
  </select>`
  if (dateFilter !== 'custom') return select
  return `${select}
    <input id="captures-date-from" class="search-input capture-date-input" type="date" value="${escapeHTML(customDateFrom)}" ${customDateTo ? `max="${escapeHTML(customDateTo)}"` : ''}>
    <span class="capture-date-sep">–</span>
    <input id="captures-date-to" class="search-input capture-date-input" type="date" value="${escapeHTML(customDateTo)}" ${customDateFrom ? `min="${escapeHTML(customDateFrom)}"` : ''}>`
}

function render(): void {
  const container = document.getElementById('captures-content')
  if (!container) return
  const state = snapshot || emptySnapshot()
  const filtered = visibleCaptures(state)
  const filtering = Boolean(searchQuery) || kindFilter !== 'all' || dateFilter !== 'all'
  let grid: string
  if (!state.captures.length) {
    grid = '<div class="captures-empty"><strong>No captures yet</strong><p>Press ⇧⌘4 to take a screenshot or ⇧⌘5 to record the screen — it will show up here within seconds.</p></div>'
  } else if (!filtered.length) {
    grid = '<div class="captures-empty"><strong>No captures match</strong><p>Try a different search term or filter.</p></div>'
  } else {
    grid = `<div class="captures-grid">${filtered.map(renderCard).join('')}</div>`
  }
  container.innerHTML = `
    <div class="captures-header">
      <div class="captures-location"><small>Screenshots &amp; recordings are saved to</small><code title="${escapeHTML(state.location)}">${escapeHTML(state.location || '…')}</code>${state.using_dedicated ? '<span class="capture-dedicated-badge">Dedicated folder</span>' : ''}</div>
      <div class="captures-header-actions">
        ${state.using_dedicated ? '' : `<button id="captures-use-dedicated" class="primary" ${busy ? 'disabled' : ''} title="Save future captures to ${escapeHTML(state.dedicated_folder)}">Move captures to a dedicated folder</button>`}
        <button id="captures-choose-folder" class="btn-secondary" ${busy ? 'disabled' : ''}>Choose folder…</button>
        <button id="captures-refresh" class="btn-secondary" ${busy ? 'disabled' : ''}>Refresh</button>
      </div>
    </div>
    ${state.error ? `<div class="captures-error">${escapeHTML(state.error)}</div>` : ''}
    ${state.captures.length ? `
    <div class="captures-toolbar">
      <input id="captures-search" class="search-input" type="search" placeholder="Search by file name…" value="${escapeHTML(searchQuery)}">
      <div class="capture-filter-group">${renderKindFilter()}</div>
      ${renderDateFilter()}
    </div>` : ''}
    <div class="captures-count">${filtering ? `${filtered.length} of ${state.captures.length}` : `${state.captures.length}`} ${state.captures.length === 1 && !filtering ? 'capture' : 'captures'} · updates automatically</div>
    ${grid}`
  if (renamingPath) {
    const input = document.getElementById('capture-rename-input') as HTMLInputElement | null
    input?.focus({ preventScroll: true })
    input?.select()
  }
}

// Thumbnails are fetched lazily one at a time after the list renders and
// patched into the existing DOM in place — never re-rendering the whole
// grid per thumbnail, and never embedded in the snapshot payload.
async function loadThumbnails(): Promise<void> {
  if (thumbsLoading) return
  thumbsLoading = true
  try {
    while (true) {
      const next = snapshot?.captures.find(capture => !thumbs.has(capture.path))
      if (!next) return
      const uri = await api.captureThumbnail(next.path).catch(() => '')
      thumbs.set(next.path, uri)
      if (!uri) continue
      const target = document.querySelector(`[data-thumb-for="${CSS.escape(next.path)}"]`)
      if (target) {
        const img = document.createElement('img')
        img.className = 'capture-thumb-img'
        img.setAttribute('data-thumb-for', next.path)
        img.src = uri
        img.alt = ''
        target.replaceWith(img)
      }
    }
  } finally {
    thumbsLoading = false
  }
}

function applySnapshot(state: CapturesSnapshot): void {
  snapshot = state
  const paths = new Set(state.captures.map(capture => capture.path))
  if (renamingPath && !paths.has(renamingPath)) renamingPath = null
  for (const path of [...thumbs.keys()]) {
    if (!paths.has(path)) thumbs.delete(path)
  }
  render()
  void loadThumbnails()
}

export async function loadCapturesView(): Promise<void> {
  try {
    applySnapshot(await api.listCaptures())
  } catch (error) {
    snapshot = emptySnapshot()
    showError(String(error))
    render()
  }
}

async function commitRename(): Promise<void> {
  const path = renamingPath
  const input = document.getElementById('capture-rename-input') as HTMLInputElement | null
  if (!path || !input) return
  const capture = snapshot?.captures.find(item => item.path === path)
  const { stem, ext } = splitName(capture?.name || '')
  const value = input.value.trim()
  if (!value || value === stem) { renamingPath = null; render(); return }
  try {
    busy = true
    const state = await api.renameCapture(path, value + ext)
    renamingPath = null
    applySnapshot(state)
  } catch (error) {
    showError(String(error))
  } finally {
    busy = false
    render()
  }
}

async function deleteCapture(path: string): Promise<void> {
  const name = snapshot?.captures.find(item => item.path === path)?.name || path
  if (!(await api.confirmDialog('Move to Trash', `Move ${name} to the Trash? You can put it back from the Trash.`))) return
  try {
    busy = true
    applySnapshot(await api.deleteCapture(path))
  } catch (error) {
    showError(String(error))
  } finally {
    busy = false
    render()
  }
}

async function useDedicatedFolder(): Promise<void> {
  const state = snapshot || emptySnapshot()
  if (!(await api.confirmDialog('Change capture location', `Save future screenshots and recordings to ${state.dedicated_folder}? This changes the macOS capture location.`))) return
  const moveExisting = await api.confirmDialog('Move existing captures', `Also move the ${state.captures.length} existing capture(s) from ${state.location} into the new folder?`)
  try {
    busy = true
    render()
    applySnapshot(await api.useDedicatedCaptureFolder(moveExisting))
  } catch (error) {
    showError(String(error))
  } finally {
    busy = false
    render()
  }
}

async function chooseFolder(): Promise<void> {
  try {
    const path = await api.pickCaptureFolder()
    if (!path) return
    if (!(await api.confirmDialog('Change capture location', `Save future screenshots and recordings to ${path}?`))) return
    busy = true
    render()
    applySnapshot(await api.setCaptureFolder(path))
  } catch (error) {
    showError(String(error))
  } finally {
    busy = false
    render()
  }
}

export function initCapturesView(): void {
  if (initialized) return
  initialized = true
  const view = document.getElementById('captures-view')
  EventsOn('captures-changed', (state: CapturesSnapshot) => {
    // Don't yank the rename input out from under the user for an unrelated
    // change (e.g. a new screenshot landing) — applySnapshot only clears
    // the rename state when the file being renamed disappeared.
    applySnapshot(state)
  })
  view?.addEventListener('keydown', event => {
    if ((event.target as HTMLElement).id !== 'capture-rename-input') return
    if (event.key === 'Enter') { event.preventDefault(); void commitRename() }
    if (event.key === 'Escape') { renamingPath = null; render() }
  })
  view?.addEventListener('input', event => {
    const target = event.target as HTMLElement
    if (target.id !== 'captures-search') return
    searchQuery = (target as HTMLInputElement).value
    render()
    // Re-rendering replaces the input's own DOM node, so focus/caret need
    // restoring afterwards — same reason handlePackageSearchInput does.
    const el = document.getElementById('captures-search') as HTMLInputElement | null
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  })
  view?.addEventListener('change', event => {
    const target = event.target as HTMLElement
    if (target.id === 'captures-date-filter') {
      dateFilter = (target as HTMLSelectElement).value as DateFilter
      render()
      return
    }
    if (target.id === 'captures-date-from') { customDateFrom = (target as HTMLInputElement).value; render(); return }
    if (target.id === 'captures-date-to') { customDateTo = (target as HTMLInputElement).value; render(); return }
  })
  view?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.closest('.capture-row-menu-panel')) button.closest<HTMLDetailsElement>('details.capture-row-menu')?.removeAttribute('open')
    if (button.dataset.captureFilter) { kindFilter = button.dataset.captureFilter as KindFilter; render(); return }
    if (button.id === 'captures-refresh') { void loadCapturesView(); return }
    if (button.id === 'captures-use-dedicated') { void useDedicatedFolder(); return }
    if (button.id === 'captures-choose-folder') { void chooseFolder(); return }
    if (button.dataset.captureRenameConfirm) { void commitRename(); return }
    if (button.dataset.captureRenameCancel) { renamingPath = null; render(); return }
    if (button.dataset.captureRename) { renamingPath = button.dataset.captureRename; render(); return }
    if (button.dataset.captureOpen) { void api.openCapture(button.dataset.captureOpen).catch(error => showError(String(error))); return }
    if (button.dataset.captureReveal) { void api.revealCapture(button.dataset.captureReveal).catch(error => showError(String(error))); return }
    if (button.dataset.captureCopy) {
      const targetPath = button.dataset.captureCopy
      const capture = snapshot?.captures.find(item => item.path === targetPath)
      const copy = capture?.kind === 'video' ? api.copyCaptureFile : api.copyCaptureImage
      void copy(targetPath).catch(error => showError(String(error)))
      return
    }
    if (button.dataset.captureOcr) {
      void api.captureOCR(button.dataset.captureOcr)
        .then(async text => {
          if (!text.trim()) { showSuccess('OCR không tìm thấy văn bản nào trong ảnh'); return }
          await copyToClipboard(text, 'Capture OCR')
          showSuccess('Đã trích xuất văn bản và sao chép vào clipboard')
        })
        .catch(error => showError(String(error)))
      return
    }
    if (button.dataset.captureEdit) {
      const targetPath = button.dataset.captureEdit
      const capture = snapshot?.captures.find(item => item.path === targetPath)
      if (capture?.kind === 'image' && editableInApp(capture.name)) { openCaptureEditor(targetPath, capture.name); return }
      void api.editCapture(targetPath).catch(error => showError(String(error)))
      return
    }
    if (button.dataset.captureDelete) { void deleteCapture(button.dataset.captureDelete); return }
  })
}
