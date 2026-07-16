// Overview: a project-centric summary derived live from Overview() on every
// refresh (desktop/app.go). Nothing here is persisted or configured by the
// user — auto-grouping and anomaly detection both happen server-side.
//
// The Runtime/Source summary lines below are derived entirely from data the
// app already loaded for the Runtime and Source Control views — no extra
// backend call is made here, so Overview never triggers a second
// Docker/process/git scan.
import type { OverviewResult, ProjectGroup, Anomaly, Service, PortUsage, Job, ActivitySummary } from '../api'
import { escapeHTML, getStatusClass } from '../dom'
import { openServiceInspector } from '../components/serviceInspector'
import { t } from '../i18n'

export interface OverviewContext {
  services: Service[]
  ports: PortUsage[]
  jobs: Job[]
  activity: ActivitySummary | null
}

export function renderOverviewView(data: OverviewResult | null, ctx: OverviewContext): void {
  const container = document.getElementById('overview-view')
  if (!container) return

  if (!data || data.projects.length === 0) {
    container.innerHTML = `<div class="empty">${t('Scanning your development environment…')}</div>`
    return
  }

  const anomaliesHTML = data.anomalies.length
    ? `<div class="anomaly-strip">${data.anomalies.map(renderAnomaly).join('')}</div>`
    : `<div class="anomaly-strip empty-strip">${t('No active incidents — everything looks healthy.')}</div>`

  const projects = sortProjectsByAttention(data.projects)

  container.innerHTML = `
    <p class="subview-desc">${t('Needs-attention projects first, then everything else — grouped live from Docker Compose, processes, and Git repositories. Nothing here is saved, it is rescanned on every refresh.')}</p>
    <div class="overview-summary-row">
      ${renderRuntimeSummary(ctx.services, ctx.ports, ctx.jobs)}
      ${renderSourceSummary(ctx.activity)}
    </div>
    ${anomaliesHTML}
    <div class="overview-grid">${projects.map(project => renderProjectCard(project, ctx.ports, ctx.jobs)).join('')}</div>
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
}

function renderRuntimeSummary(services: Service[], ports: PortUsage[], jobs: Job[]): string {
  const dockerAll = services.filter(s => s.source === 'docker')
  const running = dockerAll.filter(s => s.status !== 'stopped').length
  const processes = services.filter(s => s.source === 'process').length
  return `
    <article class="overview-summary-card">
      <span class="overview-summary-title">${t('Runtime')}</span>
      <p>${running}/${dockerAll.length} ${t('containers')} · ${processes} ${t('processes')} · ${ports.length} ${t(ports.length === 1 ? 'port' : 'ports')} · ${jobs.length} ${t(jobs.length === 1 ? 'job' : 'jobs')}</p>
    </article>`
}

function renderSourceSummary(activity: ActivitySummary | null): string {
  if (!activity) {
    return `
      <article class="overview-summary-card">
        <span class="overview-summary-title">${t('Source Control')}</span>
        <p>${t('Loading git activity…')}</p>
      </article>`
  }
  const dirty = activity.repositories.filter(r => !r.ignored && (r.changed_files > 0 || r.staged_files > 0)).length
  const parts = [`${dirty} ${t(dirty === 1 ? 'repository' : 'repositories')} ${t('changed')}`]
  if (activity.ahead) parts.push(`${activity.ahead} ${t('ahead')}`)
  if (activity.behind) parts.push(`${activity.behind} ${t('behind')}`)
  return `
    <article class="overview-summary-card">
      <span class="overview-summary-title">${t('Source Control')}</span>
      <p>${parts.join(' · ')}</p>
    </article>`
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

function renderProjectCard(project: ProjectGroup, allPorts: PortUsage[], allJobs: Job[]): string {
  const expanded = expandedOverviewProjects.has(project.name)
  const visible = expanded ? project.services : project.services.slice(0, 4)
  const hiddenCount = project.services.length - visible.length
  const overall = project.total > 0 && project.healthy === project.total ? 'healthy' : project.down > 0 ? 'critical' : 'warning'
  const portCount = allPorts.filter(p => projectOrUnassigned(p.project) === project.name).length
  const jobCount = allJobs.filter(j => projectOrUnassigned(j.project) === project.name).length
  return `
    <article class="overview-card overview-card-${overall}">
      <header>
        <strong>${escapeHTML(project.name === 'Unassigned' ? t('Unassigned') : project.name)}</strong>
        <div class="overview-card-header-actions">
          <span class="overview-badge">${project.healthy}/${project.total} ${t('healthy')}</span>
          <button class="repo-action" data-overview-goto-runtime="${escapeHTML(project.name)}" title="${t('View this group in Runtime')}">${t('Runtime')} →</button>
        </div>
      </header>
      ${project.degraded || project.down || portCount || jobCount ? `
        <div class="overview-summary">
          ${project.degraded ? `<span class="chip warning">${project.degraded} ${t('degraded')}</span>` : ''}
          ${project.down ? `<span class="chip critical">${project.down} ${t('down')}</span>` : ''}
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
        ${hiddenCount > 0
          ? `<button class="overview-more" data-overview-more="${escapeHTML(project.name)}">+${hiddenCount} ${t('more')}</button>`
          : expanded && project.services.length > 4
            ? `<button class="overview-more" data-overview-more="${escapeHTML(project.name)}">${t('Show less')}</button>`
            : ''}
      </div>
    </article>`
}
