// Top-level Security tab: runs internal/security's scan (secrets/vulns/
// sast) across whichever repos the user picks from what Thaloca has
// already discovered (see cachedRepoPaths in desktop/activity.go), for a
// whole-machine sweep. Scanning a single repo you're already looking at is
// still done from Source Control's own per-repo Security sub-tab (views/
// sourceControl.ts, renderRepoSecurity) — that one's for quick in-context
// checks, this one's for "did I leave anything anywhere". Both share the
// finding/status row renderers below rather than duplicating that markup.
import { api } from '../api'
import type { SecurityReport, SecurityFinding, SecurityScannerStatus, RepositoryActivity, ToolsSnapshot } from '../api'
import { escapeHTML, matchesSearch } from '../dom'
import { EventsOn } from '../../wailsjs/runtime/runtime'

export interface SecurityViewState {
  repos: RepositoryActivity[]
  reports: SecurityReport[] | null
  scanning: boolean
  // For the "install these first" banner — null until the Tools tab's data
  // has loaded at least once (main.ts triggers that load as soon as this
  // tab opens, same as the Tools tab itself does).
  tools: ToolsSnapshot | null
}

// The external tools each non-secrets scanner needs — secrets always has
// its own native fallback, so it's deliberately not in this list (nothing
// to prompt installing for it).
const OPTIONAL_SCAN_TOOLS: { command: string; label: string; scanner: string }[] = [
  { command: 'gitleaks', label: 'gitleaks', scanner: 'more accurate secrets detection' },
  { command: 'trivy', label: 'Trivy', scanner: 'dependency vulnerability scanning' },
  { command: 'gosec', label: 'gosec', scanner: 'Go static analysis' },
  { command: 'semgrep', label: 'Semgrep', scanner: 'multi-language static analysis' },
  { command: 'clamscan', label: 'ClamAV', scanner: 'malware scanning' },
]

function renderMissingToolsBanner(tools: ToolsSnapshot | null): string {
  if (!tools) return ''
  const installed = new Set(tools.tools.filter(t => t.installed).map(t => t.command))
  const missing = OPTIONAL_SCAN_TOOLS.filter(t => !installed.has(t.command))
  if (!missing.length) return ''
  return `
    <div class="security-tools-banner">
      <span>
        <strong>${missing.length} scanner tool${missing.length === 1 ? '' : 's'} not installed:</strong>
        ${missing.map(t => `${escapeHTML(t.label)} (${escapeHTML(t.scanner)})`).join(', ')}.
        Secrets scanning still works via a built-in fallback; the rest will show as skipped until installed.
      </span>
      <button class="btn-secondary" data-security-goto-tools="1">Go to Tools</button>
    </div>`
}

interface RepoScanProgress {
  status: 'running' | 'done'
  scanners: Record<string, 'running' | 'done'>
}

// Repo picker + live progress are inherently stateful UI concerns specific
// to this tab (not data from the backend) — kept here rather than threaded
// through main.ts, the same way views/runtime.ts keeps expandedProjects.
const selectedRepos = new Set<string>()
let selectionInitialized = false
let repoFilter = ''
const repoProgress = new Map<string, RepoScanProgress>()
let progressListenerBound = false

export function toggleRepoSelected(path: string): void {
  if (selectedRepos.has(path)) selectedRepos.delete(path)
  else selectedRepos.add(path)
}

export function selectAllRepos(repos: RepositoryActivity[]): void {
  for (const r of repos) selectedRepos.add(r.path)
}

export function selectNoRepos(): void {
  selectedRepos.clear()
}

export function setSecurityRepoFilter(value: string): void {
  repoFilter = value
}

export function getSelectedRepoPaths(): string[] {
  return [...selectedRepos]
}

// Subscribes (once — safe to call on every app init) to the scan-progress
// events desktop/security.go's RunSecurityScanAll pushes as it works
// through the repo list, so "scan all repos" shows real progress instead
// of a static "scanning..." message. onUpdate should just re-render this
// view (see renderSecurity in main.ts).
export function bindSecurityProgressListener(onUpdate: () => void): void {
  if (progressListenerBound) return
  progressListenerBound = true
  EventsOn('security-scan-progress', (progress: { repo_path: string; scanner?: string; phase: string }) => {
    if (progress.phase === 'repo_start') {
      repoProgress.set(progress.repo_path, { status: 'running', scanners: {} })
    } else if (progress.phase === 'repo_done') {
      const entry = repoProgress.get(progress.repo_path)
      if (entry) entry.status = 'done'
    } else if (progress.scanner && (progress.phase === 'scanner_start' || progress.phase === 'scanner_done')) {
      const entry = repoProgress.get(progress.repo_path)
      if (entry) entry.scanners[progress.scanner] = progress.phase === 'scanner_done' ? 'done' : 'running'
    }
    onUpdate()
  })
}

// Called right before a scan starts so a previous run's progress doesn't
// linger and read as "already done" for repos that haven't started yet.
export function resetSecurityProgress(): void {
  repoProgress.clear()
}

export function renderSecurityView(state: SecurityViewState): void {
  const container = document.getElementById('security-content')
  if (!container) return

  if (!selectionInitialized && state.repos.length) {
    selectAllRepos(state.repos)
    selectionInitialized = true
  }

  if (state.scanning) {
    container.innerHTML = renderProgress(state)
    return
  }
  if (!state.reports) {
    container.innerHTML = renderPicker(state)
    return
  }
  container.innerHTML = renderResults(state)
}

function renderPicker(state: SecurityViewState): string {
  const filtered = state.repos.filter(r => matchesSearch(repoFilter, r.name, r.path))
  const count = selectedRepos.size
  const rows = filtered.map(r => `
    <label class="security-repo-pick-row">
      <input type="checkbox" data-security-repo-check="${escapeHTML(r.path)}" ${selectedRepos.has(r.path) ? 'checked' : ''}>
      <span class="security-repo-pick-name">${escapeHTML(r.name)}</span>
      <span class="resource-detail muted">${escapeHTML(r.path)}</span>
    </label>`).join('')

  return `
    <p class="subview-desc">Runs entirely locally — nothing here leaves this machine. Uses gitleaks/trivy/gosec/semgrep if installed, with a built-in fallback for secret detection.</p>
    ${renderMissingToolsBanner(state.tools)}
    <div class="security-toolbar">
      <button class="btn-primary" data-security-scan-all="1" ${count ? '' : 'disabled'}>Scan ${count} repo${count === 1 ? '' : 's'}</button>
      <button class="btn-secondary" data-security-select-all="1">Select all</button>
      <button class="btn-secondary" data-security-select-none="1">Select none</button>
    </div>
    <input id="security-repo-filter" class="search-input" type="search" placeholder="Filter ${state.repos.length} repos..." value="${escapeHTML(repoFilter)}">
    ${filtered.length
      ? `<div class="security-repo-pick-list">${rows}</div>`
      : `<div class="empty compact">${state.repos.length ? 'No repos match the filter.' : 'No repos discovered yet.'}</div>`}`
}

function renderProgress(state: SecurityViewState): string {
  const paths = getSelectedRepoPaths()
  const doneCount = paths.filter(p => repoProgress.get(p)?.status === 'done').length
  const rows = paths.map(path => {
    const repo = state.repos.find(r => r.path === path)
    const progress = repoProgress.get(path)
    const status = progress?.status || 'queued'
    const scannerBits = progress
      ? Object.entries(progress.scanners).map(([name, s]) => `<span class="security-tool-status ${s === 'done' ? 'ok' : 'skipped'}">${s === 'done' ? '●' : '…'} ${escapeHTML(name)}</span>`).join('')
      : ''
    const marker = status === 'done' ? '✓' : status === 'running' ? '…' : '·'
    return `
      <div class="security-scan-progress-row security-scan-progress-${status}">
        <span class="resource-detail muted">${marker}</span>
        <strong>${escapeHTML(repo?.name || path)}</strong>
        <span class="security-tool-statuses">${scannerBits}</span>
      </div>`
  }).join('')

  return `
    <div class="security-toolbar"><button class="btn-primary" disabled>Scanning…</button></div>
    <p class="resource-detail muted">Scanning ${doneCount}/${paths.length} repos…</p>
    <div class="security-scan-progress-list">${rows}</div>`
}

function renderResults(state: SecurityViewState): string {
  const reports = state.reports!
  const totalFindings = reports.reduce((sum, r) => sum + r.findings.length, 0)
  const reposWithFindings = reports.filter(r => r.findings.length > 0)
  const count = selectedRepos.size

  const summary = `
    <div class="stats security-summary">
      <div class="stat-card">
        <span>Repos scanned</span>
        <strong>${reports.length}</strong>
      </div>
      <div class="stat-card${totalFindings ? ' warning' : ''}">
        <span>Total findings</span>
        <strong>${totalFindings}</strong>
      </div>
      <div class="stat-card">
        <span>Repos with findings</span>
        <strong>${reposWithFindings.length}</strong>
      </div>
    </div>`

  const body = reposWithFindings.length
    ? reposWithFindings.map(report => `
        <div class="security-repo-group">
          <h3 class="security-repo-group-title">${escapeHTML(repoName(state.repos, report.path))} <span class="resource-detail muted">${escapeHTML(report.path)}</span></h3>
          <div class="security-findings">${groupFindings(report.findings).map(g => renderFindingGroup(report.path, g)).join('')}</div>
        </div>`).join('')
    : '<div class="empty compact">No findings across any scanned repo — looks clean.</div>'

  return `
    ${renderMissingToolsBanner(state.tools)}
    <div class="security-toolbar">
      <button class="btn-primary" data-security-scan-all="1" ${count ? '' : 'disabled'}>Scan ${count} repo${count === 1 ? '' : 's'} again</button>
      <button class="btn-secondary" data-security-change-selection="1">Change selection</button>
    </div>
    ${summary}
    ${body}`
}

function repoName(repos: RepositoryActivity[], path: string): string {
  return repos.find(r => r.path === path)?.name || path
}

// Shared with views/sourceControl.ts's per-repo Security tab.
export function renderScannerStatusRow(status: SecurityScannerStatus): string {
  return `<span class="security-tool-status ${status.skipped ? 'skipped' : 'ok'}" title="${escapeHTML(status.reason || (status.skipped ? 'skipped' : 'ran fine'))}">${status.skipped ? '○' : '●'} ${escapeHTML(status.tool || status.scanner)}</span>`
}

// Shared with views/sourceControl.ts's per-repo Security tab. root is the
// scanned repo's path, needed to resolve finding.file (relative) to an
// absolute path for the Open/Reveal actions.
export interface GroupedFinding {
  scanner: string
  tool: string
  severity: SecurityFinding['severity']
  title: string
  occurrences: SecurityFinding[]
}

// Scanners commonly report the same rule/secret pattern many times over —
// once per matching file, sometimes dozens — which read as a wall of
// near-identical rows. Grouping by (scanner, tool, rule/title) collapses
// those into one row with a count, expandable to the individual files.
export function groupFindings(findings: SecurityFinding[]): GroupedFinding[] {
  const groups = new Map<string, GroupedFinding>()
  const order: string[] = []
  for (const f of findings) {
    const key = `${f.scanner}|${f.tool}|${f.rule_id || f.title}`
    let group = groups.get(key)
    if (!group) {
      group = { scanner: f.scanner, tool: f.tool, severity: f.severity, title: f.title, occurrences: [] }
      groups.set(key, group)
      order.push(key)
    }
    group.occurrences.push(f)
  }
  return order.map(key => groups.get(key)!)
}

export function renderFindingGroup(root: string, group: GroupedFinding): string {
  if (group.occurrences.length === 1) {
    return renderFindingRow(root, group.occurrences[0], true)
  }
  return `
    <details class="security-finding-group">
      <summary class="security-finding-row security-finding-summary">
        <span class="severity-badge severity-${escapeHTML(group.severity)}">${escapeHTML(group.severity)}</span>
        <div class="security-finding-body">
          <strong>${escapeHTML(group.title)}</strong>
          <span class="resource-detail muted">${escapeHTML(group.scanner)} · ${escapeHTML(group.tool)} · ${group.occurrences.length} occurrences — click to expand</span>
        </div>
      </summary>
      <div class="security-finding-occurrences">
        ${group.occurrences.map(f => renderFindingRow(root, f, false)).join('')}
      </div>
    </details>`
}

// showTitle is false inside an already-expanded group summary (title/
// severity are shown once there); true for a standalone (ungrouped) finding.
function renderFindingRow(root: string, finding: SecurityFinding, showTitle: boolean): string {
  const rootAttr = escapeHTML(root)
  const fileAttr = escapeHTML(finding.file || '')
  const line = finding.line || 0
  const body = showTitle
    ? `<div class="security-finding-body">
        <strong>${escapeHTML(finding.title)}</strong>
        <span class="resource-detail muted">${escapeHTML(finding.scanner)} · ${escapeHTML(finding.tool)}${finding.file ? ` · ${escapeHTML(finding.file)}${line ? ':' + line : ''}` : ''}</span>
        ${finding.detail ? `<span class="resource-detail muted">${escapeHTML(finding.detail)}</span>` : ''}
      </div>`
    : `<div class="security-finding-body">
        <span class="resource-detail">${finding.file ? `${escapeHTML(finding.file)}${line ? ':' + line : ''}` : escapeHTML(finding.title)}</span>
        ${finding.detail ? `<span class="resource-detail muted">${escapeHTML(finding.detail)}</span>` : ''}
      </div>`
  return `
    <div class="security-finding-row">
      ${showTitle ? `<span class="severity-badge severity-${escapeHTML(finding.severity)}">${escapeHTML(finding.severity)}</span>` : ''}
      ${body}
      ${finding.file ? `
        <div class="security-finding-actions">
          <button class="btn-icon-sm" title="Open file" data-security-open-file="${fileAttr}" data-root="${rootAttr}" data-line="${line}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </button>
          <button class="btn-icon-sm" title="Reveal in Finder" data-security-reveal-file="${fileAttr}" data-root="${rootAttr}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </button>
        </div>` : ''}
    </div>`
}
