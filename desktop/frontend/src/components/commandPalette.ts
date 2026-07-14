// Cmd+K / Ctrl+K command palette. Pure frontend: a small substring-scoring
// extension of the existing search-box filtering already used elsewhere in
// main.ts (searchQuery) — no fuzzy-search dependency added.
import { escapeHTML } from '../dom'
import { t } from '../i18n'

export interface CommandItem {
  id: string
  label: string
  hint?: string
  kind: 'view' | 'service' | 'action'
  run: () => void
}

let items: CommandItem[] = []
let isOpen = false
let query = ''
let activeIndex = 0

// Called by main.ts whenever nav views or discovered services/projects
// change, so the palette always searches current data.
export function setCommandPaletteIndex(next: CommandItem[]): void {
  items = next
}

export function initCommandPalette(): void {
  if (document.getElementById('cmdk-root')) return
  const root = document.createElement('div')
  root.id = 'cmdk-root'
  root.className = 'cmdk-overlay'
  root.innerHTML = `
    <div class="cmdk-box">
      <input class="cmdk-input" type="text" placeholder="${t('Search projects, services, and actions...')}" autocomplete="off" />
      <div class="cmdk-results"></div>
    </div>
  `
  document.body.appendChild(root)

  const input = root.querySelector<HTMLInputElement>('.cmdk-input')!
  root.addEventListener('mousedown', event => {
    if (event.target === root) close()
  })
  input.addEventListener('input', () => {
    query = input.value.trim().toLowerCase()
    activeIndex = 0
    renderResults()
  })
  input.addEventListener('keydown', event => {
    const results = filteredItems()
    if (event.key === 'Escape') { close(); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = Math.min(activeIndex + 1, results.length - 1); renderResults(); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); renderResults(); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = results[activeIndex]
      if (chosen) { close(); chosen.run() }
    }
  })

  document.addEventListener('keydown', event => {
    const isCmdK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
    if (!isCmdK) return
    event.preventDefault()
    if (isOpen) close(); else open()
  })
}

function open(): void {
  isOpen = true
  query = ''
  activeIndex = 0
  const root = document.getElementById('cmdk-root')
  if (!root) return
  root.classList.add('open')
  const input = root.querySelector<HTMLInputElement>('.cmdk-input')!
  input.value = ''
  renderResults()
  requestAnimationFrame(() => input.focus())
}

function close(): void {
  isOpen = false
  document.getElementById('cmdk-root')?.classList.remove('open')
}

// startsWith ranks above mid-string substring matches; no match => -1.
function scoreMatch(label: string, q: string): number {
  const idx = label.toLowerCase().indexOf(q)
  if (idx === -1) return -1
  return idx === 0 ? 0 : 1
}

function filteredItems(): CommandItem[] {
  if (!query) return items.slice(0, 8)
  return items
    .map(item => ({ item, score: scoreMatch(item.label, query) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 20)
    .map(x => x.item)
}

function renderResults(): void {
  const root = document.getElementById('cmdk-root')
  if (!root) return
  const results = filteredItems()
  const list = root.querySelector('.cmdk-results')
  if (!list) return
  if (!results.length) {
    list.innerHTML = `<div class="cmdk-empty">${t('No matches.')}</div>`
    return
  }
  list.innerHTML = results.map((item, i) => `
    <button class="cmdk-result ${i === activeIndex ? 'active' : ''}" data-cmdk-index="${i}">
      <span class="cmdk-kind">${escapeHTML(t(item.kind))}</span>
      <span class="cmdk-label">${escapeHTML(item.label)}</span>
      ${item.hint ? `<span class="cmdk-hint">${escapeHTML(item.hint)}</span>` : ''}
    </button>`).join('')
  list.querySelectorAll<HTMLButtonElement>('[data-cmdk-index]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.cmdkIndex)
      const chosen = results[idx]
      if (chosen) { close(); chosen.run() }
    })
  })
}
