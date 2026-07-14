// Runtime view: containers (grouped by Docker Compose project), local
// processes, and ports. Rendering is data-in (RuntimeContext) rather than
// reading module-level state directly, so this module has no dependency on
// main.ts — the same pattern used by views/overview.ts. Button clicks
// (start/stop/restart/logs/...) are still handled by main.ts's single
// document-level delegated click handler; nothing here binds its own
// listeners for those, since they work regardless of which module rendered
// the markup.
import { api, normalizeServices, normalizeJobs, normalizePorts } from '../api'
import type { Service, PortUsage, Job, HealthStatus, SecurityReport } from '../api'
import { escapeHTML, getSourceBadgeClass, matchesSearch } from '../dom'
import { groupFindings, renderFindingGroup, renderScannerStatusRow } from './security'
import { t } from '../i18n'

export interface RuntimeContext {
  services: Service[]
  ports: PortUsage[]
  jobs: Job[]
  // "" when Docker was reached fine; otherwise why it couldn't be (see
  // desktop/discovery.go's discoverAll) — shown instead of the generic
  // empty-state guess when the container list is empty.
  dockerStatus: string
  searchQuery: string
  healthCache: Map<string, HealthStatus>
  pendingContainers: Map<string, string>
  jobLogs: Map<string, string>
  projectLogs: Map<string, string>
  processLogs: Map<string, string>
  pendingProjects: Map<string, string>
  // Keyed by container ID — 'scanning' while a trivy image scan is in
  // flight, the report once it's done. See "Scan image" in
  // renderContainerRow / data-container-scan-image in main.ts.
  imageScans: Map<string, SecurityReport | 'scanning'>
}

// Which Docker Compose project groups are expanded — purely a Runtime-view
// UI concern, so it lives here rather than in main.ts's shared state.
const expandedProjects = new Set<string>()
let projectsInitialized = false

export function toggleProjectExpanded(project: string): void {
  if (expandedProjects.has(project)) expandedProjects.delete(project)
  else expandedProjects.add(project)
}

// Used by Overview's "View in Runtime" quick action, which always wants the
// group open (never collapsed) regardless of its current state.
export function expandProject(project: string): void {
  expandedProjects.add(project)
}

export function renderServicesView(ctx: RuntimeContext): void {
  const normalized = normalizeServices(ctx.services)
  const dockerAll = normalized.filter(s => s.source === 'docker')
  const processAll = normalized.filter(s => s.source === 'process')
  const runningContainers = dockerAll.filter(s => s.status !== 'stopped').length

  document.getElementById('count-docker')!.textContent = String(dockerAll.length)
  document.getElementById('count-ports')!.textContent = String(normalizePorts(ctx.ports).length)
  document.getElementById('count-processes')!.textContent = String(processAll.length)
  document.getElementById('count-jobs')!.textContent = String(normalizeJobs(ctx.jobs).length)
  document.getElementById('runtime-summary')!.textContent =
    `${runningContainers}/${dockerAll.length} ${t('containers')} · ${processAll.length} ${t('processes')} · ${normalizePorts(ctx.ports).length} ${t('ports')} · ${normalizeJobs(ctx.jobs).length} ${t('jobs')}`

  const dockerServices = dockerAll.filter(s =>
    matchesSearch(ctx.searchQuery, s.name, s.project, s.container_id, s.status, s.command, ...(s.ports || [])))
  const processServices = processAll.filter(s => matchesSearch(ctx.searchQuery, s.name, s.command, s.pid, ...(s.ports || [])))

  renderDockerProjects(dockerServices, dockerAll.length, ctx)

  const processList = document.getElementById('process-list')!
  processList.innerHTML = processServices.length
    ? `<section class="project-group expanded">${processServices.map(svc => renderProcessRow(svc, ctx)).join('')}</section>`
    : `<div class="empty compact">${processAll.length ? t('No processes match the current search.') : t('No local processes are listening on TCP ports.')}</div>`
}

function renderDockerProjects(dockerServices: Service[], totalContainers: number, ctx: RuntimeContext): void {
  const container = document.getElementById('docker-list')!
  if (dockerServices.length === 0) {
    const message = totalContainers
      ? t('No containers match the current search.')
      : ctx.dockerStatus || t('No Docker containers found.')
    container.innerHTML = `<div class="empty compact">${escapeHTML(message)}</div>`
    return
  }

  const projects = new Map<string, Service[]>()
  for (const svc of dockerServices) {
    const key = svc.project || 'standalone containers'
    const list = projects.get(key)
    if (list) list.push(svc)
    else projects.set(key, [svc])
  }

  // First render: expand projects that have something running.
  if (!projectsInitialized) {
    for (const [project, containers] of projects) {
      if (containers.some(s => s.status !== 'stopped')) expandedProjects.add(project)
    }
    projectsInitialized = true
  }

  const orderedProjects = [...projects.entries()].sort((a, b) => {
    const runA = a[1].some(s => s.status !== 'stopped') ? 0 : 1
    const runB = b[1].some(s => s.status !== 'stopped') ? 0 : 1
    return runA !== runB ? runA - runB : a[0].localeCompare(b[0])
  })

  container.innerHTML = orderedProjects.map(([project, containers]) => {
    const running = containers.filter(s => s.status !== 'stopped').length
    // While searching, always show matches even inside collapsed projects.
    const expanded = expandedProjects.has(project) || Boolean(ctx.searchQuery)
    const sorted = [...containers].sort((a, b) =>
      (a.status === 'stopped' ? 1 : 0) - (b.status === 'stopped' ? 1 : 0) || a.name.localeCompare(b.name))
    const isCompose = project !== 'standalone containers'
    const logs = ctx.projectLogs.get(project)
    const pending = ctx.pendingProjects.get(project)
    return `
      <section class="project-group ${expanded ? 'expanded' : ''}">
        <header class="project-group-header" data-toggle-project="${escapeHTML(project)}">
          <span class="repo-caret">${expanded ? '▾' : '▸'}</span>
          <strong>${escapeHTML(project === 'standalone containers' ? t('standalone containers') : project)}</strong>
          <span class="project-group-count ${running === containers.length ? 'all-running' : running > 0 ? 'partial-running' : ''}">${running}/${containers.length} ${t('running')}${pending ? ` · <span class="project-group-pending">${escapeHTML(t(pending))}…</span>` : ''}</span>
          <span class="project-group-actions">
            ${pending ? '' : `
              ${running < containers.length ? `<button class="repo-action" data-start-project="${escapeHTML(project)}">${t('Start all')}</button>` : ''}
              ${running > 0 ? `<button class="repo-action" data-restart-project="${escapeHTML(project)}">${t('Restart all')}</button>` : ''}
              ${running > 0 ? `<button class="repo-action danger" data-stop-project="${escapeHTML(project)}">${t('Stop all')}</button>` : ''}
              ${isCompose ? `<button class="repo-action" data-project-logs="${escapeHTML(project)}">${logs !== undefined ? t('Hide logs') : t('Logs')}</button>` : ''}
              ${isCompose ? `<button class="repo-action danger" data-down-project="${escapeHTML(project)}">${t('Down')}</button>` : ''}
            `}
          </span>
        </header>
        ${logs !== undefined ? `<pre class="job-log row-log">${escapeHTML(logs)}</pre>` : ''}
        ${expanded ? sorted.map(svc => renderContainerRow(svc, ctx)).join('') : ''}
      </section>`
  }).join('')
}

function renderContainerRow(svc: Service, ctx: RuntimeContext): string {
  const health = ctx.healthCache.get(svc.id)
  const stopped = svc.status === 'stopped'
  const pending = svc.container_id ? ctx.pendingContainers.get(svc.container_id) : undefined
  const state = pending ? `${t(pending)}…` : !stopped && svc.health_url && health ? health.state : svc.status
  const stateClass = pending ? 'pending' : state
  const ports = Array.isArray(svc.ports) && svc.ports.length
    ? svc.ports.map(p => `<span class="port">:${p}</span>`).join('')
    : `<span class="no-port">${t('no ports')}</span>`
  const id = escapeHTML(svc.container_id)
  const logs = svc.container_id ? ctx.jobLogs.get(svc.container_id) : undefined
  const imageScan = svc.container_id ? ctx.imageScans.get(svc.container_id) : undefined
  const image = escapeHTML(svc.image || '')
  return `
    <article class="container-row ${stopped ? 'stopped' : ''} ${pending ? 'pending' : ''}">
      <span class="status-dot status-${escapeHTML(stateClass || 'unknown')}"></span>
      <div class="container-name">
        <div class="container-name-row">
          <strong>${escapeHTML(svc.name || t('container'))}</strong>
          ${svc.engine ? `<span class="engine-badge" title="${t('Docker context')}">${escapeHTML(svc.engine)}</span>` : ''}
        </div>
        <small>${escapeHTML(svc.container_id ? svc.container_id.slice(0, 12) : '')}${health?.message && !stopped && !pending ? ` · ${escapeHTML(health.message)}` : ''}</small>
      </div>
      <span class="container-ports">${ports}</span>
      <span class="status-badge status-${escapeHTML(stateClass || 'unknown')}">${escapeHTML(state || 'unknown')}</span>
      <span class="row-actions">
        ${pending ? '' : `
          <button class="repo-action" data-container-logs="${id}">${logs !== undefined ? t('Hide logs') : t('Logs')}</button>
          ${svc.image ? `<button class="repo-action" data-container-scan-image="${id}" data-image="${image}" ${imageScan === 'scanning' ? 'disabled' : ''}>${imageScan === 'scanning' ? t('Scanning…') : imageScan ? t('Hide scan') : t('Scan image')}</button>` : ''}
          ${stopped
            ? `<button class="repo-action" data-start-container="${id}">${t('Start')}</button>`
            : `
              <button class="repo-action" data-terminal-container="${id}">${t('Terminal')}</button>
              <button class="repo-action" data-restart-container="${id}">${t('Restart')}</button>
              <button class="repo-action danger" data-stop-container="${id}">${t('Stop')}</button>`}`}
      </span>
      ${logs !== undefined ? `<pre class="job-log row-log">${escapeHTML(logs)}</pre>` : ''}
      ${imageScan && imageScan !== 'scanning' ? renderImageScanPanel(svc.image || '', imageScan) : ''}
    </article>`
}

function renderImageScanPanel(image: string, report: SecurityReport): string {
  const statusRow = report.statuses.map(renderScannerStatusRow).join('')
  const findingsHTML = report.findings.length
    ? `<div class="security-findings">${groupFindings(report.findings).map(g => renderFindingGroup(image, g)).join('')}</div>`
    : `<div class="empty compact">${t('No known vulnerabilities found in this image.')}</div>`
  return `
    <div class="security-tab image-scan-panel">
      <div class="security-tool-statuses">${statusRow}</div>
      ${findingsHTML}
    </div>`
}

// Local processes shown as compact rows, same layout as containers.
function renderProcessRow(svc: Service, ctx: RuntimeContext): string {
  const ports = Array.isArray(svc.ports) && svc.ports.length
    ? svc.ports.map(p => `<span class="port">:${p}</span>`).join('')
    : `<span class="no-port">${t('no ports')}</span>`
  const pidKey = svc.pid ? String(svc.pid) : ''
  const logs = pidKey ? ctx.processLogs.get(pidKey) : undefined
  return `
    <article class="container-row">
      <span class="status-dot status-${escapeHTML(svc.status || 'unknown')}"></span>
      <div class="container-name">
        <strong>${escapeHTML(svc.name || t('process'))}</strong>
        <small>${escapeHTML(svc.command || '')}</small>
      </div>
      <span class="container-ports">${ports}</span>
      <span class="muted">${svc.pid ? `${t('PID')} ${svc.pid}` : ''}</span>
      <span class="row-actions">
        ${svc.pid ? `<button class="repo-action" data-process-logs="${svc.pid}">${logs !== undefined ? t('Hide logs') : t('Logs')}</button>` : ''}
        ${svc.pid ? `<button class="repo-action danger" data-stop-pid="${svc.pid}">${t('Stop')}</button>` : ''}
      </span>
      ${logs !== undefined ? `<pre class="job-log row-log">${escapeHTML(logs)}</pre>` : ''}
    </article>`
}

export function renderPortsView(ports: PortUsage[], searchQuery: string): void {
  const all = normalizePorts(ports)
  const normalized = all.filter(p => matchesSearch(searchQuery, p.port, p.process, p.name, p.command, p.container_id, p.source))
  const container = document.getElementById('ports-list')!
  if (all.length === 0) {
    container.innerHTML = `<div class="empty compact">${t('No listening ports detected.')}</div>`
    return
  }
  if (normalized.length === 0) {
    container.innerHTML = `<div class="empty compact">${t('No ports match the current search.')}</div>`
    return
  }

  container.innerHTML = normalized.map(port => `
    <article class="port-row">
      <span class="port-number">:${port.port}</span>
      <span class="${getSourceBadgeClass(port.source || 'unknown')}">${escapeHTML(port.source || 'unknown')}</span>
      <div class="port-owner">
        <strong>${escapeHTML(port.name || port.process || t('unknown'))}</strong>
        <small>${escapeHTML(port.command || port.address || '')}</small>
      </div>
      <span class="muted">${port.pid ? `${t('PID')} ${port.pid}` : port.container_id ? `${t('Container')} ${port.container_id.slice(0, 12)}` : ''}</span>
      ${port.container_id
        ? `<button class="repo-action danger" data-stop-container="${escapeHTML(port.container_id)}">${t('Stop')}</button>`
        : port.pid ? `<button class="repo-action danger" data-stop-pid="${port.pid}">${t('Stop')}</button>` : '<span></span>'}
    </article>
  `).join('')
}

export function renderJobsView(jobs: Job[], searchQuery: string, jobLogs: Map<string, string>): void {
  const all = normalizeJobs(jobs)
  document.getElementById('count-jobs')!.textContent = String(all.length)

  const normalized = all.filter(j => matchesSearch(searchQuery, j.name, j.command, j.project, j.source, j.status, ...(j.processes || [])))

  const container = document.getElementById('jobs-list')!
  if (all.length === 0) {
    container.innerHTML = `<div class="empty">${t('No background jobs discovered yet. Thaloca checks Docker worker containers, cron, launchd, and PM2.')}</div>`
    return
  }
  if (normalized.length === 0) {
    container.innerHTML = `<div class="empty compact">${t('No jobs match the current search.')}</div>`
    return
  }

  container.innerHTML = normalized.map(job => {
    const logs = job.container_id ? jobLogs.get(job.container_id) : undefined
    return `
    <article class="job-card">
      <header>
        <span class="${getSourceBadgeClass(job.source || 'unknown')}">${escapeHTML((job.source || 'unknown').toUpperCase())}</span>
        <strong>${escapeHTML(job.name || t('Background job'))}</strong>
        ${job.container_id ? `<button class="repo-action" data-job-logs="${escapeHTML(job.container_id)}">${logs !== undefined ? t('Hide logs') : t('Show logs')}</button>` : ''}
        <span class="status-badge status-${escapeHTML(job.status || 'unknown')}">${escapeHTML(job.status || 'unknown')}</span>
      </header>
      <div class="job-meta">
        ${job.schedule ? `<span><b>${t('Schedule:')}</b> ${escapeHTML(job.schedule)}</span>` : ''}
        ${job.project ? `<span><b>${t('Project:')}</b> ${escapeHTML(job.project)}</span>` : ''}
        ${job.pid ? `<span><b>${t('PID:')}</b> ${job.pid}</span>` : ''}
        ${job.container_id ? `<span><b>${t('Container:')}</b> ${escapeHTML(job.container_id.slice(0,12))}</span>` : ''}
      </div>
      <code>${escapeHTML(job.command || '')}</code>
      ${job.processes?.length ? `
        <div class="job-procs">
          <span class="job-procs-title">${t('Running inside')}</span>
          ${job.processes.map(proc => `<code class="job-proc">${escapeHTML(proc)}</code>`).join('')}
        </div>` : ''}
      ${logs !== undefined ? `<pre class="job-log">${escapeHTML(logs)}</pre>` : ''}
    </article>
  `}).join('')
}

export async function checkAllHealth(services: Service[], healthCache: Map<string, HealthStatus>): Promise<void> {
  const withHealth = normalizeServices(services).filter(s => s.health_url)
  await Promise.all(withHealth.map(async svc => {
    try {
      const health = await api.checkHealth(svc.health_url)
      healthCache.set(svc.id, health)
    } catch {
      healthCache.set(svc.id, { state: 'error', message: t('Check failed'), latency: 0, name: '', type: '', target: '', status_code: 0, checked_at: '' })
    }
  }))
}
