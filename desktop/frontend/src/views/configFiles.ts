// Config Files view: lists files sourced by shell startup files (e.g. a
// dedicated claude_telemetry.zsh), well-known global dev-tool config files,
// and a read-only telemetry inventory for Claude Code. Only "shell" entries
// can be toggled, and only when doing so is safe (see
// desktop/configFiles.go) — "tool"/"telemetry" entries are always
// display-only, since most of them mix auth/identity with whatever setting
// a user might actually want off, so renaming the whole file would break
// more than intended.
import type { ConfigFileEntry } from '../api'
import { api } from '../api'
import { escapeHTML, showError } from '../dom'
import { t } from '../i18n'

let entries: ConfigFileEntry[] | null = null
let loading = false
let filterQuery = ''
let togglingID = ''

export function initConfigFilesView(): void {
  if (entries !== null) {
    renderConfigFilesView()
    return
  }
  void loadConfigFiles()
}

export async function loadConfigFiles(): Promise<void> {
  loading = true
  renderConfigFilesView()
  try {
    entries = (await api.listConfigFiles()) || []
  } catch (error) {
    showError(String(error))
    entries = []
  }
  loading = false
  renderConfigFilesView()
}

async function toggle(entry: ConfigFileEntry): Promise<void> {
  if (togglingID || !entry.toggleable) return
  if (entry.enabled) {
    const scope = entry.source_name ? ` (${t('sourced from')} ${entry.source_name})` : ''
    if (!(await api.confirmDialog(
      t('Disable config file'),
      `${t('Disable')} ${entry.name}${scope}? ${t('This renames it to')} "${entry.name}.disabled" ${t('on disk — nothing is deleted, and you can enable it again the same way.')}`,
    ))) return
  }
  togglingID = entry.id
  renderConfigFilesView()
  try {
    const enabled = await api.toggleConfigFile(entry.path)
    entry.enabled = enabled
  } catch (error) {
    showError(String(error))
  }
  togglingID = ''
  renderConfigFilesView()
}

function matchesFilter(entry: ConfigFileEntry, query: string): boolean {
  if (!query) return true
  return `${entry.name} ${entry.source_name || ''} ${entry.path} ${entry.description}`.toLowerCase().includes(query)
}

function renderShellRow(entry: ConfigFileEntry): string {
  const busy = togglingID === entry.id
  return `
    <div class="config-row">
      <div class="config-row-main">
        <div class="config-row-title">
          <code class="config-row-name">${escapeHTML(entry.name)}</code>
          ${entry.source_name ? `<span class="muted">${t('from')} ${escapeHTML(entry.source_name)}</span>` : ''}
          <span class="config-badge ${entry.enabled ? 'config-badge-on' : 'config-badge-off'}">${entry.enabled ? t('Enabled') : t('Disabled')}</span>
          ${!entry.toggleable ? `<span class="config-badge config-badge-readonly">${t('View only')}</span>` : ''}
        </div>
        <p class="config-row-desc">${escapeHTML(entry.description)}</p>
      </div>
      ${entry.toggleable
        ? `<label class="toggle-switch" title="${busy ? t('Working…') : entry.enabled ? t('Disable') : t('Enable')}">
            <input type="checkbox" data-config-toggle="${escapeHTML(entry.id)}" ${entry.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>
            <span class="toggle-switch-track"><span class="toggle-switch-thumb"></span></span>
          </label>`
        : ''}
    </div>`
}

function renderReadOnlyRow(entry: ConfigFileEntry): string {
  return `
    <div class="config-row config-row-readonly">
      <div class="config-row-main">
        <div class="config-row-title">
          <code class="config-row-name">${escapeHTML(entry.name)}</code>
          <span class="config-badge ${entry.exists ? 'config-badge-on' : 'config-badge-off'}">${entry.exists ? t('Found') : t('Not found')}</span>
          <span class="config-badge config-badge-readonly">${t('View only')}</span>
        </div>
        <p class="config-row-desc">${escapeHTML(entry.description)}</p>
        ${entry.detected_value ? `<p class="config-row-value"><code>${escapeHTML(entry.detected_value)}</code></p>` : ''}
      </div>
    </div>`
}

function renderSection(title: string, desc: string, items: ConfigFileEntry[], rowFn: (e: ConfigFileEntry) => string): string {
  if (items.length === 0) return ''
  return `
    <div class="config-section">
      <div class="config-section-title">${escapeHTML(title)}</div>
      <p class="subview-desc">${escapeHTML(desc)}</p>
      <div class="config-section-rows">${items.map(rowFn).join('')}</div>
    </div>`
}

// Collapsed by default (native <details>, no extra state to manage) — this
// is the broad, unfiltered sweep of every dotfile sitting in $HOME, which
// can include things like a stray ~/.env, so it stays tucked away until
// deliberately expanded rather than dumped in the open like the curated
// sections above.
function renderCollapsibleSection(title: string, desc: string, items: ConfigFileEntry[], rowFn: (e: ConfigFileEntry) => string): string {
  if (items.length === 0) return ''
  return `
    <details class="config-section config-section-collapsible">
      <summary class="config-section-title">${escapeHTML(title)} (${items.length})</summary>
      <p class="subview-desc">${escapeHTML(desc)}</p>
      <div class="config-section-rows">${items.map(rowFn).join('')}</div>
    </details>`
}

export function renderConfigFilesView(): void {
  const root = document.getElementById('config-files-content')
  if (!root) return
  const all = entries || []
  const query = filterQuery.trim().toLowerCase()
  const filtered = all.filter(e => matchesFilter(e, query))

  const shell = filtered.filter(e => e.category === 'shell')
  const home = filtered.filter(e => e.category === 'home')
  const tool = filtered.filter(e => e.category === 'tool')
  const telemetry = filtered.filter(e => e.category === 'telemetry')

  root.innerHTML = `
    <div class="env-toolbar">
      <input id="config-filter" class="search-input" type="search" placeholder="${t('Filter config files...')}" value="${escapeHTML(filterQuery)}">
      <button class="btn-secondary" id="config-refresh-btn" ${loading ? 'disabled' : ''}>${loading ? t('Scanning…') : t('Refresh')}</button>
    </div>
    ${loading && entries === null ? `<div class="empty compact">${t('Scanning for config files…')}</div>` : ''}
    ${!loading && filtered.length === 0 ? `<div class="empty compact">${t('No config files matched.')}</div>` : ''}
    ${renderSection(t('Shell-sourced files'), t('Files your shell startup files (.zshrc, .bashrc, ...) source in — only ones that are safe to switch off (guarded against a missing file, and not committed to git) get a button.'), shell, renderShellRow)}
    ${renderCollapsibleSection(t('Other dotfiles in your home folder'), t('Everything else starting with "." directly in your home folder (e.g. a stray ~/.env), plus files inside ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.azure, ~/.m2, ~/.terraform.d, and each ~/.config subfolder. Not tied to any shell startup file, so Thaloca only knows renaming it won\'t touch git history. Collapsed by default since some of these can be sensitive.'), home, renderShellRow)}
    ${renderSection(t('Dev tools'), t('Global config files for tools on this machine, shown for visibility only. Most mix login/identity with other settings, so Thaloca never renames or edits them.'), tool, renderReadOnlyRow)}
    ${renderSection(t('Telemetry'), t('Read-only inventory of telemetry-related settings Thaloca can safely detect. These aren’t edited here — change them yourself in the source tool if you want a different value.'), telemetry, renderReadOnlyRow)}
  `

  document.getElementById('config-filter')?.addEventListener('input', event => {
    filterQuery = (event.target as HTMLInputElement).value
    const cursor = (event.target as HTMLInputElement).selectionStart
    renderConfigFilesView()
    const newInput = document.getElementById('config-filter') as HTMLInputElement | null
    if (newInput) {
      newInput.focus()
      if (cursor !== null) newInput.setSelectionRange(cursor, cursor)
    }
  })
  document.getElementById('config-refresh-btn')?.addEventListener('click', () => void loadConfigFiles())
  root.querySelectorAll<HTMLInputElement>('[data-config-toggle]').forEach(input => {
    input.addEventListener('change', () => {
      const id = input.dataset.configToggle || ''
      const entry = (entries || []).find(e => e.id === id)
      if (entry) void toggle(entry)
    })
  })
}
