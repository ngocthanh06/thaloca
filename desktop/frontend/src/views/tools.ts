// Tools & Packages Manager. Detection (versions, missing-per-project) is
// read-only; Install/Update actually runs a command (see toolActions.go),
// so those always go through a native confirm dialog first and show their
// live output in the panel below the grid while they run. Package
// search/install/uninstall follows the same confirm-then-run-then-poll
// convention regardless of registry — Homebrew (brewPackages.go) against
// an arbitrary formula/cask name, or npm/PyPI/crates.io/Packagist
// (languagePackages.go) against an arbitrary package name, all global/
// system-wide installs (no per-project package.json/requirements.txt
// editing).
import type { ToolsSnapshot, ToolInfo, ProjectToolRequirement, ToolActionStatus, BrewSearchResult, BrewPackages, RegistryPackage, LanguageRegistry } from '../api'
import { escapeHTML, formatDate } from '../dom'
import { t } from '../i18n'

export type PackageRegistryKey = 'brew' | LanguageRegistry

const REGISTRY_LABELS: Record<PackageRegistryKey, string> = {
  brew: 'Homebrew',
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'Cargo',
  composer: 'Composer',
}

export interface ToolActionState {
  tool: string
  name: string
  action: 'install' | 'update' | 'uninstall'
  command: string
  status: ToolActionStatus
}

export interface ToolsViewState {
  snapshot: ToolsSnapshot | null
  activeAction: ToolActionState | null
}

export function renderToolsView(state: ToolsViewState): void {
  const container = document.getElementById('tools-content')
  if (!container) return

  const { snapshot, activeAction } = state
  if (!snapshot || !snapshot.sampled_at) {
    container.innerHTML = `<div class="empty">${t('Checking installed tools…')}</div>`
    return
  }

  container.innerHTML = `
    ${activeAction ? renderActionPanel(activeAction) : ''}

    <p class="resource-detail muted tools-last-checked">${t('Last checked:')} ${escapeHTML(formatDate(snapshot.sampled_at))}</p>

    <div class="tool-grid">
      ${snapshot.tools.map(renderToolCard).join('')}
    </div>

    <h3 class="section-title">${t('Projects missing a tool')}</h3>
    <div class="resource-list">
      ${snapshot.projects.length ? snapshot.projects.map(renderProjectGapRow).join('') : `<div class="empty compact">${t('Every detected project has the tools its manifest asks for.')}</div>`}
    </div>
  `
}

// Package search + installed-packages management gets its own Tools sub-tab
// (see main.ts's #tools-packages-content) rather than living at the bottom
// of Detected Tools, so it's reachable without scrolling past the 17-tool
// grid and the missing-tool project list first.
export interface PackagesViewState {
  activeAction: ToolActionState | null
  activeRegistry: PackageRegistryKey
  packageSearchQuery: string
  packageSearching: boolean
  // Only one of these two is ever populated, matching activeRegistry —
  // Homebrew's own search result shape (name + formula/cask) doesn't carry
  // over to the other four registries, which just have a name + optional
  // description.
  brewSearchResults: BrewSearchResult[] | null
  languageSearchResults: RegistryPackage[] | null
  installedBrewPackages: BrewPackages | null
  installedLanguagePackages: string[] | null
}

export function renderPackagesView(state: PackagesViewState): void {
  const container = document.getElementById('tools-packages-content')
  if (!container) return

  const isBrew = state.activeRegistry === 'brew'
  const searchPlaceholder = state.activeRegistry === 'pypi'
    ? t('Exact package name (PyPI has no fuzzy search)...')
    : isBrew
      ? t('Search formulae and casks by name...')
      : `${t('Search')} ${REGISTRY_LABELS[state.activeRegistry]} ${t('packages by name...')}`

  container.innerHTML = `
    ${state.activeAction ? renderActionPanel(state.activeAction) : ''}

    <div class="subtabs">
      ${(Object.keys(REGISTRY_LABELS) as PackageRegistryKey[]).map(key => `
        <button class="subtab ${key === state.activeRegistry ? 'active' : ''}" data-package-registry="${key}">${REGISTRY_LABELS[key]}</button>
      `).join('')}
    </div>

    <div class="tool-package-search">
      <input class="search-input" id="package-search-input" type="search" placeholder="${escapeHTML(searchPlaceholder)}" value="${escapeHTML(state.packageSearchQuery)}" autofocus>
    </div>
    ${isBrew
      ? renderBrewSearchResults(state.packageSearchQuery, state.brewSearchResults, state.packageSearching)
      : renderLanguageSearchResults(state.packageSearchQuery, state.languageSearchResults, state.packageSearching)}

    <h3 class="section-title">${t('Installed packages')}</h3>
    ${isBrew ? renderInstalledBrewPackages(state.installedBrewPackages) : renderInstalledLanguagePackages(state.installedLanguagePackages)}
  `
}

function renderBrewSearchResults(query: string, results: BrewSearchResult[] | null, searching: boolean): string {
  if (!query.trim()) return ''
  if (searching) return `<div class="empty compact">${t('Searching…')}</div>`
  if (!results) return ''
  if (!results.length) return `<div class="empty compact">${t('No formulae or casks match')} "${escapeHTML(query)}".</div>`
  return `
    <div class="resource-list">
      ${results.map(r => `
        <div class="resource-row">
          <span class="resource-row-label">${escapeHTML(r.name)}</span>
          <span class="resource-row-detail muted">${r.is_cask ? 'Cask' : 'Formula'}</span>
          <span class="resource-row-actions">
            <button class="btn-secondary" data-package-install="${escapeHTML(r.name)}" data-package-cask="${r.is_cask ? '1' : '0'}">${t('Install')}</button>
          </span>
        </div>`).join('')}
    </div>`
}

function renderLanguageSearchResults(query: string, results: RegistryPackage[] | null, searching: boolean): string {
  if (!query.trim()) return ''
  if (searching) return `<div class="empty compact">${t('Searching…')}</div>`
  if (!results) return ''
  if (!results.length) return `<div class="empty compact">${t('No packages match')} "${escapeHTML(query)}".</div>`
  return `
    <div class="resource-list">
      ${results.map(r => `
        <div class="resource-row">
          <span class="resource-row-label">${escapeHTML(r.name)}</span>
          <span class="resource-row-detail muted truncate" title="${escapeHTML(r.description || '')}">${escapeHTML(r.description || '')}</span>
          <span class="resource-row-actions">
            <button class="btn-secondary" data-package-install="${escapeHTML(r.name)}">${t('Install')}</button>
          </span>
        </div>`).join('')}
    </div>`
}

function renderInstalledBrewPackages(packages: BrewPackages | null): string {
  if (!packages) return `<div class="empty compact">${t('Loading installed packages…')}</div>`
  return `
    ${renderPackageGroup('Formulae', packages.formulae, false)}
    ${renderPackageGroup('Casks', packages.casks, true)}
  `
}

function renderInstalledLanguagePackages(names: string[] | null): string {
  if (!names) return `<div class="empty compact">${t('Loading installed packages…')}</div>`
  return renderPackageGroup(t('Installed'), names, false)
}

function renderPackageGroup(label: string, names: string[], isCask: boolean): string {
  return `
    <h4 class="tool-package-group-title">${escapeHTML(label)} (${names.length})</h4>
    <div class="resource-list">
      ${names.length
        ? names.map(name => `
          <div class="resource-row">
            <span class="resource-row-label">${escapeHTML(name)}</span>
            <span class="resource-row-actions">
              <button class="btn-secondary" data-package-uninstall="${escapeHTML(name)}" data-package-cask="${isCask ? '1' : '0'}">${t('Uninstall')}</button>
            </span>
          </div>`).join('')
        : `<div class="empty compact">${t('None.')}</div>`}
    </div>`
}

function renderToolCard(tool: ToolInfo): string {
  const action = !tool.installed && tool.install_command
    ? `<button class="btn-secondary" data-tool-install="${escapeHTML(tool.command)}" data-tool-name="${escapeHTML(tool.name)}" data-tool-command="${escapeHTML(tool.install_command)}">${t('Install')}</button>`
    : tool.installed && tool.update_command
      ? `<button class="btn-secondary" data-tool-update="${escapeHTML(tool.command)}" data-tool-name="${escapeHTML(tool.name)}" data-tool-command="${escapeHTML(tool.update_command)}">${t('Update')}</button>`
      : ''
  return `
    <article class="tool-card ${tool.installed ? 'installed' : 'missing'}">
      <header>
        <strong>${escapeHTML(tool.name)}</strong>
        <span class="tool-status ${tool.installed ? 'installed' : 'missing'}">${tool.installed ? t('Installed') : t('Not installed')}</span>
      </header>
      <p class="resource-detail">${tool.installed ? escapeHTML(tool.version || tool.command) : `${t('Not found on PATH')} (${escapeHTML(tool.command)})`}</p>
      ${tool.installed && tool.path ? `<p class="resource-detail muted" title="${escapeHTML(tool.path)}">${escapeHTML(tool.path)}</p>` : ''}
      ${tool.managed_by ? `<p class="resource-detail muted">${t('Managed by')} ${escapeHTML(tool.managed_by)} — ${t('Install/Update not offered here to avoid a conflicting Homebrew copy.')}</p>` : ''}
      ${action ? `<div class="tool-card-actions">${action}</div>` : ''}
    </article>`
}

function renderProjectGapRow(p: ProjectToolRequirement): string {
  return `
    <div class="resource-row">
      <span class="resource-row-label" title="${escapeHTML(p.path)}">${escapeHTML(p.project)}</span>
      <span class="resource-row-detail">${t('missing:')} ${p.missing.map(escapeHTML).join(', ')}</span>
      <span class="resource-row-detail muted">${t('requires:')} ${p.required.map(escapeHTML).join(', ')}</span>
    </div>`
}

function renderActionPanel(state: ToolActionState): string {
  const { status } = state
  const label = state.action === 'install' ? t('Installing') : state.action === 'uninstall' ? t('Uninstalling') : t('Updating')
  const statusText = status.running
    ? t('Running…')
    : status.error
      ? `${t('Failed:')} ${escapeHTML(status.error)}`
      : status.exit_code === 0
        ? t('Done.')
        : `${t('Exited with code')} ${status.exit_code}.`
  return `
    <div class="tool-action-panel">
      <header>
        <strong>${label} ${escapeHTML(state.name)}</strong>
        <code>${escapeHTML(state.command)}</code>
        ${status.running ? '' : `<button class="btn-secondary" data-tool-action-close>${t('Close')}</button>`}
      </header>
      <pre class="tool-action-output">${escapeHTML(status.output || t('(no output yet)'))}</pre>
      <p class="resource-detail ${status.running ? '' : status.error || status.exit_code !== 0 ? 'tool-action-failed' : 'tool-action-ok'}">${statusText}</p>
    </div>`
}
