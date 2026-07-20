// Overview: a project-centric summary derived live from Overview() on every
// refresh (desktop/app.go). Nothing here is persisted or configured by the
// user — auto-grouping and anomaly detection both happen server-side.
//
// The Runtime/Source summary lines below are derived entirely from data the
// app already loaded for the Runtime and Source Control views — no extra
// backend call is made here, so Overview never triggers a second
// Docker/process/git scan.
import type { OverviewResult, ProjectGroup, Anomaly, Service, PortUsage, Job, ActivitySummary, ProductPreferences } from '../api'
import { escapeHTML, getStatusClass, showError } from '../dom'
import { openServiceInspector } from '../components/serviceInspector'
import { t } from '../i18n'
import { api } from '../api'

export interface OverviewContext {
  services: Service[]
  ports: PortUsage[]
  jobs: Job[]
  activity: ActivitySummary | null
}

type OverviewProjectLayout = 'compact' | 'detailed'
const OVERVIEW_PROJECT_LAYOUT_KEY = 'thaloca-overview-project-layout'
let overviewProjectLayout: OverviewProjectLayout = localStorage.getItem(OVERVIEW_PROJECT_LAYOUT_KEY) === 'detailed' ? 'detailed' : 'compact'
let productPreferences: ProductPreferences = { expected_projects: {}, workspaces: [], document_policies: {} }
let preferencesLoaded = false
let activeWorkspaceID = localStorage.getItem('thaloca-overview-workspace') || ''
let lastOverviewData: OverviewResult | null = null
let lastOverviewContext: OverviewContext | null = null

export function renderOverviewView(data: OverviewResult | null, ctx: OverviewContext): void {
  activeWorkspaceID = localStorage.getItem('thaloca-overview-workspace') || ''
  lastOverviewData = data; lastOverviewContext = ctx
  const container = document.getElementById('overview-view')
  if (!container) return

  if (!data || data.projects.length === 0) {
    container.innerHTML = `<div class="empty">${t('Scanning your development environment…')}</div>`
    return
  }

  if (!preferencesLoaded) {
    preferencesLoaded = true
    void api.productPreferences().then(value => { productPreferences = value; if (lastOverviewData && lastOverviewContext) renderOverviewView(lastOverviewData, lastOverviewContext) })
  }
  const activeWorkspace = productPreferences.workspaces.find(profile => profile.id === activeWorkspaceID)
  const scopedProjects = activeWorkspace ? data.projects.filter(project => activeWorkspace.projects.includes(project.name)) : data.projects
  const projects = sortProjectsByAttention(scopedProjects)
  const totalServices = data.projects.reduce((sum, project) => sum + project.total, 0)
  const healthyServices = data.projects.reduce((sum, project) => sum + project.healthy, 0)
  const downServices = data.projects.reduce((sum, project) => sum + project.down, 0)
  const degradedServices = data.projects.reduce((sum, project) => sum + project.degraded, 0)
  const dirtyRepos = ctx.activity?.repositories.filter(repo => !repo.ignored && (repo.changed_files > 0 || repo.staged_files > 0)).length || 0
  const hasRuntimeIssues = downServices > 0 || degradedServices > 0 || data.anomalies.length > 0
  const scannedAt = data.scanned_at ? new Date(data.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : t('just now')

  container.innerHTML = `
    <section class="overview-command-center ${hasRuntimeIssues ? 'needs-attention' : 'healthy'}">
      <div class="overview-command-copy">
        <small>${t('Workspace status')} · ${t('Updated')} ${escapeHTML(scannedAt)}</small>
        <h2>${hasRuntimeIssues ? t('Runtime needs attention') : t('Everything is running smoothly')}</h2>
        <p>${hasRuntimeIssues ? t('Each number below has one source and one meaning.') : t('No incidents or unhealthy services detected. You can continue where you left off.')}</p>
      </div>
      <div class="overview-status-signals">
        <button data-overview-nav="runtime" class="${downServices || degradedServices ? 'warning' : ''}"><strong>${healthyServices}/${totalServices}</strong><span>${t('services healthy')}</span>${downServices ? `<em>${downServices} ${t('down')}</em>` : degradedServices ? `<em>${degradedServices} ${t('degraded')}</em>` : ''}</button>
        <button data-overview-nav="incidents" class="${data.anomalies.length ? 'warning' : ''}"><strong>${data.anomalies.length}</strong><span>${t('incidents')}</span></button>
        <button data-overview-nav="source" class="${ctx.activity?.behind ? 'warning' : ''}"><strong>${dirtyRepos}</strong><span>${t('repositories changed')}</span>${ctx.activity?.behind ? `<em>${ctx.activity.behind} ${t('commits behind')}</em>` : ''}</button>
      </div>
    </section>

    <section class="overview-workspace-tabs" aria-label="${t('Workspace shortcuts')}">
      <span>${t('Workspace')}</span>
      ${renderWorkspaceTab('source', 'Source Control', dirtyRepos ? `${dirtyRepos} ${t('changed')}` : t('Clean'))}
      ${renderWorkspaceTab('documents', 'Documents', t('Search'))}
      ${renderWorkspaceTab('captures', 'Captures', t('Recent'))}
      ${renderWorkspaceTab('runtime', 'Runtime', `${ctx.services.length} ${t('services')}`)}
      ${renderWorkspaceTab('incidents', 'Incidents', data.anomalies.length ? `${data.anomalies.length}` : t('All clear'))}
    </section>

    <section class="overview-panel overview-attention-panel">
      <header><div><small>${t('Priority')}</small><h3>${t('Needs your attention')}</h3></div>${data.anomalies.length ? `<button data-overview-nav="incidents">${t('Open incidents')} →</button>` : ''}</header>
      ${data.anomalies.length ? `<div class="anomaly-strip">${data.anomalies.map(renderAnomaly).join('')}</div>` : `<div class="overview-clear-state"><span>✓</span><div><strong>${t('Nothing urgent')}</strong><p>${t('Thaloca did not detect restart loops, degraded services, or log errors.')}</p></div></div>`}
    </section>

    <section class="overview-projects-section">
      <header><div><small>${t('Workspace')}</small><h3>${t('Projects')}</h3></div><div class="overview-project-controls"><span>${projects.length} ${t(projects.length === 1 ? 'project' : 'projects')}</span><div role="group" aria-label="${t('Project display')}"><button data-overview-layout="compact" class="${overviewProjectLayout === 'compact' ? 'active' : ''}">${t('Compact')}</button><button data-overview-layout="detailed" class="${overviewProjectLayout === 'detailed' ? 'active' : ''}">${t('Detailed')}</button></div></div></header>
      <div class="overview-profile-bar"><button data-overview-workspace="" class="${!activeWorkspace ? 'active' : ''}">${t('All projects')}</button>${productPreferences.workspaces.map(profile => `<span class="overview-profile-pill"><button data-overview-workspace="${escapeHTML(profile.id)}" class="${activeWorkspaceID === profile.id ? 'active' : ''}">${escapeHTML(profile.name)} <small>${profile.projects.length}</small></button>${activeWorkspaceID === profile.id ? `<button data-delete-workspace="${escapeHTML(profile.id)}" title="${t('Delete workspace')}">×</button>` : ''}</span>`).join('')}<details><summary>+ ${t('Custom workspace')}</summary><form id="overview-workspace-form"><input name="name" placeholder="${t('Workspace name')}" required>${data.projects.map(project => `<label><input type="checkbox" name="project" value="${escapeHTML(project.name)}"> ${escapeHTML(project.name)}</label>`).join('')}<button type="submit" class="btn-secondary">${t('Save workspace')}</button></form></details></div>
      <div class="overview-grid overview-grid-${overviewProjectLayout}">${projects.map(project => renderProjectCard(project, ctx.ports, ctx.jobs, overviewProjectLayout)).join('')}</div>
    </section>
  `

  container.querySelectorAll<HTMLElement>('[data-overview-service]').forEach(el => {
    el.addEventListener('click', () => {
      const service = findService(data.projects, el.dataset.overviewService || '')
      if (service) openServiceInspector(service)
    })
  })

  container.querySelectorAll<HTMLElement>('[data-overview-more]').forEach(el => {
    el.addEventListener('click', () => {
      toggleOverviewProjectExpanded(el.dataset.overviewMore || '')
      renderOverviewView(data, ctx)
    })
  })
  container.querySelectorAll<HTMLElement>('[data-overview-nav]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>(`.nav-btn[data-view="${CSS.escape(el.dataset.overviewNav || '')}"]`)?.click()
    })
  })
  container.querySelectorAll<HTMLButtonElement>('[data-overview-layout]').forEach(button => {
    button.addEventListener('click', () => {
      overviewProjectLayout = button.dataset.overviewLayout === 'detailed' ? 'detailed' : 'compact'
      localStorage.setItem(OVERVIEW_PROJECT_LAYOUT_KEY, overviewProjectLayout)
      renderOverviewView(data, ctx)
    })
  })
  container.querySelectorAll<HTMLSelectElement>('[data-overview-expected]').forEach(select => {
    select.addEventListener('change', () => {
      select.disabled = true
      void api.setProjectExpectedState(select.dataset.overviewExpected || '', select.value)
        .then(() => document.dispatchEvent(new CustomEvent('thaloca:refresh')))
        .catch(error => showError(String(error)))
        .finally(() => { select.disabled = false })
    })
  })
  container.querySelectorAll<HTMLButtonElement>('[data-overview-workspace]').forEach(button => button.addEventListener('click', () => {
    activeWorkspaceID = button.dataset.overviewWorkspace || ''
    localStorage.setItem('thaloca-overview-workspace', activeWorkspaceID)
    renderOverviewView(data, ctx)
  }))
  container.querySelector<HTMLFormElement>('#overview-workspace-form')?.addEventListener('submit', event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget as HTMLFormElement)
    const name = String(form.get('name') || '').trim()
    const projects = form.getAll('project').map(String)
    if (!name || !projects.length) return
    void api.saveWorkspaceProfile({ id: '', name, projects })
      .then(value => { productPreferences = value; renderOverviewView(data, ctx) })
      .catch(error => showError(String(error)))
  })
  container.querySelectorAll<HTMLButtonElement>('[data-delete-workspace]').forEach(button => button.addEventListener('click', () => {
    void api.deleteWorkspaceProfile(button.dataset.deleteWorkspace || '')
      .then(value => { productPreferences = value; activeWorkspaceID = ''; localStorage.removeItem('thaloca-overview-workspace'); renderOverviewView(data, ctx) })
      .catch(error => showError(String(error)))
  }))
}

function renderWorkspaceTab(view: string, label: string, detail: string): string {
  return `<button data-overview-nav="${view}"><strong>${t(label)}</strong><small>${escapeHTML(detail)}</small></button>`
}

function findService(projects: ProjectGroup[], id: string): Service | undefined {
  for (const project of projects) {
    const found = project.services.find(s => s.id === id)
    if (found) return found
  }
  return undefined
}

function renderAnomaly(a: Anomaly): string {
  // Log-based anomalies link straight to the offending service's logs
  // (Service Inspector already has a Logs toggle for docker services) —
  // other anomaly kinds (restart loop, degraded) don't carry a log tail.
  const clickable = a.kind === 'log_error'
  return `
    <div class="anomaly-row severity-${escapeHTML(a.severity)}${clickable ? ' anomaly-row-clickable' : ''}" ${clickable ? `data-overview-service="${escapeHTML(a.service_id)}"` : ''}>
      <span class="anomaly-dot"></span>
      <div>
        <strong>${escapeHTML(a.name)}</strong>
        <span class="anomaly-project">${escapeHTML(a.project)}</span>
        <p>${escapeHTML(a.message)}</p>
      </div>
      ${clickable ? `<span class="anomaly-link-hint">${t('View logs →')}</span>` : ''}
    </div>`
}

// projectOrUnassigned mirrors projectOrUnassigned in desktop/overview.go so
// ports/jobs without a project label land in the same "Unassigned" bucket
// the backend already grouped services into.
// Returns the raw (untranslated) "Unassigned" — this value is also used to
// match port/job counts against project.name below, which comes from the
// backend's own grouping (desktop/overview.go) and is never translated, so
// translating it here would break that match. Display-side translation
// happens separately, at the one place project.name is actually shown.
function projectOrUnassigned(project: string | undefined): string {
  return project && project.trim() !== '' ? project : 'Unassigned'
}

// Which project cards have been expanded past the initial 4 services —
// purely a display preference, reset on app restart like everything else
// in Overview.
const expandedOverviewProjects = new Set<string>()

function toggleOverviewProjectExpanded(name: string): void {
  if (expandedOverviewProjects.has(name)) expandedOverviewProjects.delete(name)
  else expandedOverviewProjects.add(name)
}

// "Needs attention" ordering: projects with something actually down sort
// first, then degraded, then fully healthy ones — Unassigned (not a real
// project, just a catch-all) always sorts last regardless of health.
// Array.prototype.sort is stable, so ties keep the backend's own
// (alphabetical) order.
function sortProjectsByAttention(projects: ProjectGroup[]): ProjectGroup[] {
  const rank = (p: ProjectGroup): number => {
    if (p.name === 'Unassigned') return 3
    if (p.down > 0) return 0
    if (p.degraded > 0) return 1
    return 2
  }
  return [...projects].sort((a, b) => rank(a) - rank(b))
}

function renderProjectCard(project: ProjectGroup, allPorts: PortUsage[], allJobs: Job[], layout: OverviewProjectLayout): string {
  const expanded = expandedOverviewProjects.has(project.name)
  const visible = layout === 'compact' && !expanded ? [] : expanded ? project.services : project.services.slice(0, 4)
  const hiddenCount = project.services.length - visible.length
  const optional = project.expected_state === 'on_demand' || project.expected_state === 'muted'
  const overall = optional ? 'optional' : project.total > 0 && project.healthy === project.total ? 'healthy' : project.down > 0 ? 'critical' : 'warning'
  const portCount = allPorts.filter(p => projectOrUnassigned(p.project) === project.name).length
  const jobCount = allJobs.filter(j => projectOrUnassigned(j.project) === project.name).length
  return `
    <article class="overview-card overview-card-${overall} ${layout === 'compact' ? 'overview-card-compact' : ''} ${expanded ? 'expanded' : ''}">
      <header>
        <strong title="${escapeHTML(project.name === 'Unassigned' ? t('Unassigned') : project.name)}">${escapeHTML(project.name === 'Unassigned' ? t('Unassigned') : project.name)}</strong>
        <div class="overview-card-header-actions">
          <span class="overview-badge">${project.healthy}/${project.total} ${t('healthy')}</span>
          <select class="overview-expected-select" data-overview-expected="${escapeHTML(project.name)}" title="${t('Expected state')}">
            <option value="required" ${(!project.expected_state || project.expected_state === 'required') ? 'selected' : ''}>${t('Must run')}</option>
            <option value="on_demand" ${project.expected_state === 'on_demand' ? 'selected' : ''}>${t('On demand')}</option>
            <option value="muted" ${project.expected_state === 'muted' ? 'selected' : ''}>${t('Muted')}</option>
          </select>
          <button class="repo-action" data-overview-goto-runtime="${escapeHTML(project.name)}" title="${t('View this group in Runtime')}">${t('Runtime')} →</button>
        </div>
      </header>
      ${project.degraded || project.down || portCount || jobCount ? `
        <div class="overview-summary">
          ${project.degraded ? `<span class="chip warning">${project.degraded} ${t('degraded')}</span>` : ''}
          ${project.down ? `<span class="chip critical">${project.down} ${t('stopped')}</span>` : ''}
          ${portCount ? `<span class="chip">${portCount} ${t(portCount === 1 ? 'port' : 'ports')}</span>` : ''}
          ${jobCount ? `<span class="chip">${jobCount} ${t(jobCount === 1 ? 'job' : 'jobs')}</span>` : ''}
        </div>` : ''}
      <div class="overview-services">
        ${visible.map(s => `
          <button class="overview-service-row" data-overview-service="${escapeHTML(s.id)}">
            <span class="status-dot ${getStatusClass(s.status)}"></span>
            <span class="overview-service-name">${escapeHTML(s.name)}</span>
            <span class="overview-service-ports">${(s.ports || []).map(p => ':' + p).join(' ')}</span>
          </button>`).join('')}
        ${layout === 'compact' && !expanded
          ? `<button class="overview-more" data-overview-more="${escapeHTML(project.name)}">${project.services.length} ${t('services')} · ${t('Show services')} ↓</button>`
          : hiddenCount > 0
          ? `<button class="overview-more" data-overview-more="${escapeHTML(project.name)}">+${hiddenCount} ${t('more')}</button>`
          : expanded && project.services.length > 4
            ? `<button class="overview-more" data-overview-more="${escapeHTML(project.name)}">${t('Collapse')} ↑</button>`
            : ''}
      </div>
    </article>`
}
