// Side panel showing one service's detail, generalized from the existing
// master-detail pattern already used by Source Control (renderSource /
// renderCommitFilesPanel in main.ts). Mounted into #inspector-panel, a
// sibling of <main> in the app shell markup (see renderApp in main.ts).
import { api } from '../api'
import type { Service, HealthSamplePoint } from '../api'
import { escapeHTML, formatDuration, getStatusClass } from '../dom'
import { t } from '../i18n'

let currentService: Service | null = null
let logs: string | undefined

export function openServiceInspector(service: Service): void {
  currentService = service
  logs = undefined
  const panel = document.getElementById('inspector-panel')
  if (!panel) return
  panel.classList.add('open')
  render()
  void loadHealthHistory(service)
}

export function closeServiceInspector(): void {
  currentService = null
  logs = undefined
  document.getElementById('inspector-panel')?.classList.remove('open')
}

async function toggleLogs(service: Service): Promise<void> {
  if (logs !== undefined) {
    logs = undefined
    render()
    return
  }
  logs = t('Loading logs...')
  render()
  try {
    logs = String((await api.containerLogs(service.container_id)) || t('No log output.'))
  } catch (error) {
    logs = `${t('Could not read logs:')} ${String(error)}`
  }
  if (currentService?.id === service.id) render()
}

// Actions mutate live state (Docker/process), so callers need to know when
// to rescan. A custom event keeps this module decoupled from main.ts's
// runtime-loading internals instead of importing them directly.
function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent('thaloca:refresh'))
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'stop-process'

// Shared by the inspector's own buttons and the Command Palette, so both
// surfaces reuse the exact same confirm-before-destructive-action pattern.
export async function runServiceAction(service: Service, action: ServiceAction): Promise<void> {
  try {
    switch (action) {
      case 'restart': {
        const ok = await api.confirmDialog(`${t('Restart')} ${service.name}?`, t('This will restart the container.'))
        if (!ok) return
        await api.restartContainer(service.container_id)
        break
      }
      case 'stop': {
        const ok = await api.confirmDialog(`${t('Stop')} ${service.name}?`, t('This will stop the container.'))
        if (!ok) return
        await api.stopContainer(service.container_id)
        break
      }
      case 'start':
        await api.startContainer(service.container_id)
        break
      case 'stop-process': {
        const ok = await api.confirmDialog(`${t('Stop')} ${service.name}?`, t('This will terminate the process.'))
        if (!ok) return
        await api.stopProcess(service.pid)
        break
      }
    }
    requestRefresh()
  } catch (err) {
    console.error(err)
  }
}

async function loadHealthHistory(service: Service): Promise<void> {
  if (!service.health_url) {
    renderSparkline([])
    return
  }
  const history = await api.healthHistory(service.health_url)
  if (currentService?.id === service.id) renderSparkline(history)
}

function renderSparkline(history: HealthSamplePoint[]): void {
  const el = document.getElementById('inspector-sparkline')
  if (!el) return
  if (!history.length) {
    el.innerHTML = `<p class="empty compact">${t('No health samples yet this session.')}</p>`
    return
  }
  const latencies = history.map(h => h.latency || 0)
  const max = Math.max(...latencies, 1)
  const points = latencies.map((v, i) => {
    const x = (i / Math.max(history.length - 1, 1)) * 100
    const y = 30 - (v / max) * 28
    return `${x},${y}`
  }).join(' ')
  const last = history[history.length - 1]
  el.innerHTML = `
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" class="sparkline-svg">
      <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
    <span class="sparkline-caption">${escapeHTML(last.state)} · ${formatDuration(last.latency)}</span>
  `
}

function render(): void {
  const panel = document.getElementById('inspector-panel')
  if (!panel || !currentService) return
  const s = currentService
  panel.innerHTML = `
    <header class="inspector-header">
      <div>
        <strong>${escapeHTML(s.name)}</strong>
        <span class="status-badge ${getStatusClass(s.status)}">${escapeHTML(s.status)}</span>
      </div>
      <button class="icon-btn" data-inspector-close aria-label="Close">&times;</button>
    </header>
    <div class="inspector-body">
      <dl class="inspector-facts">
        <dt>${t('Source')}</dt><dd>${escapeHTML(s.source)}</dd>
        ${s.ports?.length ? `<dt>${t('Ports')}</dt><dd>${s.ports.map(p => ':' + p).join(', ')}</dd>` : ''}
        ${s.project ? `<dt>${t('Project')}</dt><dd>${escapeHTML(s.project)}</dd>` : ''}
        ${s.repo_path ? `<dt>${t('Repository')}</dt><dd>${escapeHTML(s.repo_path)}</dd>` : ''}
        ${s.command ? `<dt>${t('Command')}</dt><dd class="mono">${escapeHTML(s.command)}</dd>` : ''}
      </dl>
      <div id="inspector-sparkline" class="inspector-sparkline"></div>
      <div class="inspector-actions">
        ${s.source === 'docker' && s.status !== 'stopped' ? `<button data-inspector-action="restart">${t('Restart')}</button>` : ''}
        ${s.source === 'docker' && s.status === 'stopped' ? `<button data-inspector-action="start">${t('Start')}</button>` : ''}
        ${s.source === 'docker' && s.status !== 'stopped' ? `<button class="danger" data-inspector-action="stop">${t('Stop')}</button>` : ''}
        ${s.source === 'process' ? `<button class="danger" data-inspector-action="stop-process">${t('Stop')}</button>` : ''}
        ${s.source === 'docker' && s.container_id ? `<button data-inspector-logs>${logs !== undefined ? t('Hide logs') : t('Logs')}</button>` : ''}
      </div>
      ${logs !== undefined ? `<pre class="job-log">${escapeHTML(logs)}</pre>` : ''}
    </div>
  `
  panel.querySelector('[data-inspector-close]')?.addEventListener('click', closeServiceInspector)
  panel.querySelectorAll<HTMLButtonElement>('[data-inspector-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentService) void runServiceAction(currentService, btn.dataset.inspectorAction as ServiceAction)
    })
  })
  panel.querySelector('[data-inspector-logs]')?.addEventListener('click', () => {
    if (currentService) void toggleLogs(currentService)
  })
}
