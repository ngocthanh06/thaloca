// Env Files (Tools > Env Files): lists which KEYS each discovered
// project's .env defines, without ever loading values up front —
// aggregating every project's real secret values into one place would turn
// any future bug in Thaloca into a leak of all of them at once, instead of
// one project's own .env. A value is only ever fetched one key at a time,
// on explicit click, and never persisted here — closing/refreshing this
// panel forgets it.
import type { EnvFileSummary } from '../api'
import { api } from '../api'
import { escapeHTML, showError } from '../dom'
import { copyToClipboard } from '../clipboard'
import { t } from '../i18n'

let files: EnvFileSummary[] | null = null
let loading = false
let filterQuery = ''
// `${project_path}\x1f${file_name}\x1f${key}` -> revealed value.
const revealed = new Map<string, string>()
const revealing = new Set<string>()

function keyId(f: EnvFileSummary, key: string): string {
  return `${f.project_path}\x1f${f.file_name}\x1f${key}`
}

function fileId(f: EnvFileSummary): string {
  return `${f.project_path}\x1f${f.file_name}`
}

let copyingFile = ''

async function copyFile(f: EnvFileSummary): Promise<void> {
  const id = fileId(f)
  if (copyingFile) return
  if (!(await api.confirmDialog(t('Copy .env file'), `${t('Copy the full contents of')} ${f.file_name} ${t('in')} ${f.project_name} ${t('to the clipboard? This includes every real secret value in the file, and it will also be recorded in Copy History.')}`))) return
  copyingFile = id
  renderEnvFilesView()
  try {
    const content = await api.getEnvFileContent(f.project_path, f.file_name)
    await copyToClipboard(content, `${f.project_name}/${f.file_name}`)
  } catch (error) {
    showError(String(error))
  }
  copyingFile = ''
  renderEnvFilesView()
}

export function initEnvFilesView(): void {
  if (files !== null) {
    renderEnvFilesView()
    return
  }
  void loadEnvFiles()
}

export async function loadEnvFiles(): Promise<void> {
  loading = true
  revealed.clear()
  renderEnvFilesView()
  try {
    files = (await api.listEnvFiles()) || []
  } catch (error) {
    showError(String(error))
    files = []
  }
  loading = false
  renderEnvFilesView()
}

async function toggleReveal(f: EnvFileSummary, key: string): Promise<void> {
  const id = keyId(f, key)
  if (revealed.has(id)) {
    revealed.delete(id)
    renderEnvFilesView()
    return
  }
  revealing.add(id)
  renderEnvFilesView()
  try {
    revealed.set(id, await api.getEnvValue(f.project_path, f.file_name, key))
  } catch (error) {
    showError(String(error))
  }
  revealing.delete(id)
  renderEnvFilesView()
}

function renderEnvKeyRow(f: EnvFileSummary, key: string): string {
  const id = keyId(f, key)
  const isRevealing = revealing.has(id)
  const value = revealed.get(id)
  const idAttr = escapeHTML(id)
  return `
    <div class="env-key-row">
      <code class="env-key-name">${escapeHTML(key)}</code>
      ${value !== undefined ? `<code class="env-key-value">${escapeHTML(value)}</code>` : ''}
      <button class="btn-secondary env-reveal-btn" data-env-toggle="${idAttr}" ${isRevealing ? 'disabled' : ''}>
        ${isRevealing ? t('Loading…') : value !== undefined ? t('Hide') : t('Show value')}
      </button>
    </div>`
}

function renderEnvFile(f: EnvFileSummary): string {
  const isCopying = copyingFile === fileId(f)
  return `
    <div class="env-file">
      <div class="env-file-header">
        <div class="env-file-name">${escapeHTML(f.file_name)} <span class="muted">(${f.keys.length} ${t(f.keys.length === 1 ? 'key' : 'keys')})</span></div>
        <button class="btn-secondary env-copy-file-btn" data-env-copy-file="${escapeHTML(fileId(f))}" ${isCopying ? 'disabled' : ''}>${isCopying ? t('Copying…') : t('Copy file')}</button>
      </div>
      <div class="env-key-list">${f.keys.map(key => renderEnvKeyRow(f, key)).join('')}</div>
    </div>`
}

export function renderEnvFilesView(): void {
  const root = document.getElementById('env-files-content')
  if (!root) return
  const all = files || []
  const query = filterQuery.trim().toLowerCase()
  const filtered = query
    ? all.filter(f => `${f.project_name} ${f.file_name} ${f.keys.join(' ')}`.toLowerCase().includes(query))
    : all

  const groups = new Map<string, EnvFileSummary[]>()
  for (const f of filtered) {
    const list = groups.get(f.project_name) || []
    list.push(f)
    groups.set(f.project_name, list)
  }

  root.innerHTML = `
    <div class="env-toolbar">
      <input id="env-filter" class="search-input" type="search" placeholder="${t('Filter projects, files, keys...')}" value="${escapeHTML(filterQuery)}">
      <button class="btn-secondary" id="env-refresh-btn" ${loading ? 'disabled' : ''}>${loading ? t('Scanning…') : t('Refresh')}</button>
    </div>
    ${loading && files === null ? `<div class="empty compact">${t('Scanning discovered projects for .env files…')}</div>` : ''}
    ${!loading && filtered.length === 0 ? `<div class="empty compact">${t('No .env files found in any discovered project.')}</div>` : ''}
    <div class="env-groups">
      ${[...groups.entries()].map(([project, list]) => `
        <div class="env-project-group">
          <div class="env-project-title">${escapeHTML(project)}</div>
          ${list.map(f => renderEnvFile(f)).join('')}
        </div>`).join('')}
    </div>`

  document.getElementById('env-filter')?.addEventListener('input', event => {
    filterQuery = (event.target as HTMLInputElement).value
    const cursor = (event.target as HTMLInputElement).selectionStart
    renderEnvFilesView()
    // renderEnvFilesView() replaces this input's own DOM node (it's part of
    // the same innerHTML as the filtered results below it), which drops
    // focus after every keystroke unless it's restored here — otherwise
    // typing a second character needs clicking back into the box first.
    const newInput = document.getElementById('env-filter') as HTMLInputElement | null
    if (newInput) {
      newInput.focus()
      if (cursor !== null) newInput.setSelectionRange(cursor, cursor)
    }
  })
  document.getElementById('env-refresh-btn')?.addEventListener('click', () => void loadEnvFiles())
  root.querySelectorAll<HTMLButtonElement>('[data-env-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.envToggle || ''
      const [projectPath, fileName, key] = id.split('\x1f')
      const f = (files || []).find(x => x.project_path === projectPath && x.file_name === fileName)
      if (f) void toggleReveal(f, key)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-env-copy-file]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.envCopyFile || ''
      const [projectPath, fileName] = id.split('\x1f')
      const f = (files || []).find(x => x.project_path === projectPath && x.file_name === fileName)
      if (f) void copyFile(f)
    })
  })
}
