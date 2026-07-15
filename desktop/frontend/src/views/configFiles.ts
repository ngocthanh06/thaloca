// Config Files view: lists files sourced by shell startup files (e.g. a
// dedicated claude_telemetry.zsh), well-known global dev-tool config files,
// and a Claude Code telemetry inventory. "shell", "home", and "tool"
// entries toggle by renaming the file to/from "<name>.disabled" (see
// desktop/configFiles.go's ToggleConfigFile); "telemetry" toggles instead
// by writing/removing env keys inside settings.json (ToggleTelemetry),
// since it isn't a file of its own to rename.
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
  const isTelemetry = entry.category === 'telemetry'

  if (entry.enabled) {
    let message: string
    if (isTelemetry) {
      message = `${t('Disable Claude Code telemetry')}? ${t('This writes DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING, and DISABLE_NON_ESSENTIAL_MODEL_CALLS (all "true") plus CLAUDE_CODE_ENABLE_TELEMETRY ("false") into this file\'s "env" block — re-enabling removes all four again. If any of these are also set as real shell environment variables, those can still override this.')}`
    } else {
      const scope = entry.source_name ? ` (${t('sourced from')} ${entry.source_name})` : ''
      // Every category's per-row description already spells out what's
      // actually inside / at risk (login-auth mix for "tool" entries, an
      // unguarded source line or a git-tracked file for "shell"/"home"
      // entries) — surface it here too, not just in the page's static text,
      // since that's the one place guaranteed to be read before the rename
      // actually happens.
      message = `${t('Disable')} ${entry.name}${scope}? ${entry.description} ${t('This renames it to')} "${entry.name}.disabled" ${t('on disk — nothing is deleted, and you can enable it again the same way.')}`
    }
    if (!(await api.confirmDialog(t('Disable config file'), message))) return
  }
  togglingID = entry.id
  renderConfigFilesView()
  try {
    entry.enabled = isTelemetry ? await api.toggleTelemetry() : await api.toggleConfigFile(entry.path)
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
        ${entry.detected_value ? `<p class="config-row-value"><code>${escapeHTML(entry.detected_value)}</code></p>` : ''}
      </div>
      ${entry.toggleable
        ? `<label class="toggle-switch" title="${busy ? t('Working…') : entry.enabled ? t('Disable') : t('Enable')}">
            <input type="checkbox" data-config-toggle="${escapeHTML(entry.id)}" ${entry.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>
            <span class="toggle-switch-track"><span class="toggle-switch-thumb"></span></span>
          </label>`
        : ''}
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
    ${renderSection(t('Dev tools'), t('Global config files for tools on this machine. Most mix login/identity with other settings — read each one\'s description before switching it off, since disabling it can log you out or change how that tool behaves until you re-enable it.'), tool, renderShellRow)}
    ${renderSection(t('Telemetry'), t('Claude Code telemetry-related settings, read from and written to this file\'s "env" block. The same variables can also be set as real shell environment variables, which Thaloca can\'t see or override.'), telemetry, renderShellRow)}
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
