import { api, type Anomaly, type TimelineEvent } from '../api'
import { escapeHTML, showError } from '../dom'
import { t } from '../i18n'

function loadAcknowledged(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem('thaloca.incidents.ack') || '[]')
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(-200) : [])
  } catch {
    return new Set()
  }
}

const acknowledged = loadAcknowledged()
let anomalies: Anomaly[] = []
let events: TimelineEvent[] = []
let loading = false

function incidentKey(item: Anomaly): string {
  return `${item.kind}:${item.service_id}:${item.since}`
}

function saveAcknowledged(): void {
  localStorage.setItem('thaloca.incidents.ack', JSON.stringify([...acknowledged].slice(-200)))
}

function severityForEvent(event: TimelineEvent): string {
  const value = `${event.kind} ${event.message}`.toLowerCase()
  if (/failed|down|stopped|fatal|panic|error/.test(value)) return 'critical'
  if (/changed|exited|restart|warning/.test(value)) return 'warning'
  return 'info'
}

function render(): void {
  const root = document.getElementById('incidents-content')
  if (!root) return
  const active = anomalies.filter(item => !acknowledged.has(incidentKey(item)))
  const critical = active.filter(item => item.severity === 'critical').length
  root.innerHTML = `
    <div class="feature-hero"><div><h2>${t('Health Watch')}</h2><p>${t('One place for active incidents and recent operational changes.')}</p></div><button id="incidents-refresh" class="btn-secondary" ${loading ? 'disabled' : ''}>${t(loading ? 'Refreshing…' : 'Refresh')}</button></div>
    <div class="feature-metrics">
      <article><strong>${active.length}</strong><span>${t('Active')}</span></article>
      <article><strong>${critical}</strong><span>${t('Critical')}</span></article>
      <article><strong>${acknowledged.size}</strong><span>${t('Acknowledged')}</span></article>
      <article><strong>${events.length}</strong><span>${t('Recent events')}</span></article>
    </div>
    <section class="feature-panel"><header><div><strong>${t('Active incidents')}</strong><small>${t('Detected from container state, jobs, health checks and logs')}</small></div></header>
      <div class="incident-list">${active.length ? active.map(item => `
        <article class="incident-item severity-${escapeHTML(item.severity)}">
          <span class="anomaly-dot"></span><div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.project || t('Unassigned'))} · ${new Date(item.since).toLocaleString()}</small><p>${escapeHTML(item.message)}</p></div>
          <span class="incident-actions"><button class="btn-secondary" data-open-incident-runtime="${escapeHTML(item.project)}">${t('Open Runtime')}</button>${item.project ? `<button class="btn-secondary" data-mute-incident-project="${escapeHTML(item.project)}">${t('Mute project')}</button>` : ''}<button class="btn-secondary" data-ack-incident="${escapeHTML(incidentKey(item))}">${t('Acknowledge')}</button></span>
        </article>`).join('') : `<div class="feature-empty"><strong>${t('All clear')}</strong><p>${t('No active incident was found in the latest scan.')}</p></div>`}</div>
    </section>
    <section class="feature-panel"><header><div><strong>${t('Incident timeline')}</strong><small>${t('Newest operational events first')}</small></div></header>
      <div class="incident-list">${events.length ? events.map(event => `
        <article class="incident-item severity-${severityForEvent(event)}"><span class="anomaly-dot"></span><div><strong>${escapeHTML(event.name)}</strong><small>${new Date(event.at).toLocaleString()} · ${escapeHTML(event.category)}</small><p>${escapeHTML(event.message)}</p></div></article>`).join('') : `<div class="feature-empty"><p>${t('No runtime event has been recorded in this session yet.')}</p></div>`}</div>
    </section>`
}

export async function loadIncidentsView(): Promise<void> {
  loading = true; render()
  try {
    const [snapshot, recent] = await Promise.all([api.snapshot(false), api.recentEvents(100)])
    anomalies = snapshot.anomalies || []
    events = recent || []
  } catch (error) {
    showError(String(error))
  } finally { loading = false; render() }
}

export function initIncidentsView(): void {
  document.getElementById('incidents-content')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.id === 'incidents-refresh') { void loadIncidentsView(); return }
    const key = button.dataset.ackIncident
    if (key) { acknowledged.add(key); saveAcknowledged(); render() }
    if (button.hasAttribute('data-open-incident-runtime')) { document.querySelector<HTMLButtonElement>('.nav-btn[data-view="runtime"]')?.click(); return }
    if (button.hasAttribute('data-mute-incident-project')) {
      const project = button.dataset.muteIncidentProject
      if (!project) { showError(t('Project is required')); return }
      void api.setProjectExpectedState(project, 'muted')
        .then(() => loadIncidentsView())
        .catch(error => showError(String(error)))
      return
    }
  })
}
