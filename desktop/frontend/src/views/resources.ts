// Resource Monitor: a live read of machine resources (App.Resources(), see
// desktop/resources.go). Rendering is data-in like views/overview.ts —
// main.ts owns the polling interval and passes the latest snapshot in.
import type { ResourceSnapshot, DiskStats, NetworkInterfaceStats, GPUInfo, ProcessInfo, InstalledApp, ResourceSample } from '../api'
import { escapeHTML, formatBytes, matchesSearch } from '../dom'
import { renderResourceHistory, type HistoryWindow } from '../components/resourceCharts'

export interface ProcessSort {
  by: 'pid' | 'cpu' | 'mem'
  dir: 'asc' | 'desc'
}

export function renderResourcesView(snapshot: ResourceSnapshot | null, searchQuery = '', sort: ProcessSort = { by: 'cpu', dir: 'desc' }, apps: InstalledApp[] = [], history: ResourceSample[] = [], historyWindow: HistoryWindow = '1h'): void {
  const container = document.getElementById('resources-content')
  if (!container) return

  if (!snapshot || !snapshot.sampled_at) {
    container.innerHTML = `<div class="empty">Reading system resources…</div>`
    return
  }

  const cpuUsed = snapshot.cpu.user_percent + snapshot.cpu.system_percent
  const swapUsedPercent = snapshot.swap.total_mb > 0 ? (snapshot.swap.used_mb / snapshot.swap.total_mb) * 100 : 0

  container.innerHTML = `
    <div class="resource-grid">
      ${renderMeterCard('CPU', cpuUsed, `${snapshot.cpu.user_percent.toFixed(1)}% user · ${snapshot.cpu.system_percent.toFixed(1)}% sys · ${snapshot.cpu.idle_percent.toFixed(1)}% idle`)}
      ${renderMeterCard('Memory', snapshot.memory.used_percent, `${formatBytes(snapshot.memory.used_bytes)} used of ${formatBytes(snapshot.memory.total_bytes)}`)}
      ${renderMeterCard('Swap', swapUsedPercent, snapshot.swap.total_mb > 0 ? `${snapshot.swap.used_mb.toFixed(0)} MB used of ${snapshot.swap.total_mb.toFixed(0)} MB` : 'No swap in use')}
      ${renderBatteryCard(snapshot)}
    </div>

    <h3 class="section-title">History</h3>
    ${renderResourceHistory(history, historyWindow)}

    <h3 class="section-title">Applications</h3>
    ${renderAppsList(apps, searchQuery)}

    <h3 class="section-title">Disks</h3>
    <div class="resource-list">
      ${snapshot.disks.length ? snapshot.disks.map(renderDiskRow).join('') : '<div class="empty compact">No disk info available.</div>'}
    </div>

    <h3 class="section-title">Network</h3>
    <div class="resource-list">
      ${snapshot.network.length ? snapshot.network.map(renderNetworkRow).join('') : '<div class="empty compact">No active network interfaces detected.</div>'}
    </div>

    ${snapshot.gpus?.length ? `
      <h3 class="section-title">GPU</h3>
      <div class="resource-list">${snapshot.gpus.map(renderGPURow).join('')}</div>` : ''}

    <h3 class="section-title">Processes</h3>
    ${renderProcessTable(snapshot.processes || [], searchQuery, sort)}
  `
}

function renderAppsList(apps: InstalledApp[], searchQuery: string): string {
  if (!apps.length) {
    return `<div class="empty compact">No applications detected yet.</div>`
  }
  const filtered = apps.filter(a => matchesSearch(searchQuery, a.name, a.bundle_id, a.version))
  if (!filtered.length) {
    return `<div class="empty compact">No applications match your search.</div>`
  }
  // Running apps first (heaviest CPU first among those), then everything
  // else alphabetically — mirrors the "what's using resources right now"
  // framing the Processes table already has.
  const sorted = [...filtered].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    if (a.running && b.running) return b.cpu_percent - a.cpu_percent
    return a.name.localeCompare(b.name)
  })
  return `<div class="resource-list">${sorted.map(renderAppRow).join('')}</div>`
}

function renderAppRow(app: InstalledApp): string {
  return `
    <div class="resource-row">
      <span class="resource-row-label" title="${escapeHTML(app.path)}">${escapeHTML(app.name)}</span>
      <span class="resource-row-detail muted">${escapeHTML(app.version || '—')}</span>
      ${app.running
        ? `<span class="resource-row-detail">${app.cpu_percent.toFixed(1)}% CPU · ${app.mem_percent.toFixed(1)}% Mem</span>`
        : `<span class="resource-row-detail muted">Not running</span>`}
      <span class="resource-row-actions">
        ${app.running
          ? `<button class="repo-action danger" data-quit-app="${escapeHTML(app.bundle_id)}">Quit</button>`
          : `<button class="repo-action" data-open-app="${escapeHTML(app.path)}">Open</button>`}
      </span>
    </div>`
}

// A full system process list can be 400-600 rows; rebuilding that many DOM
// nodes on every 3s poll is what made the whole app feel laggy (this is one
// shared webview main thread, so a big reflow here stalls other tabs too).
// Capping the *unfiltered* view to the top N by CPU keeps the common case
// cheap; searching still scans every process, not just the capped list.
const MAX_UNFILTERED_ROWS = 150

// Filters reuse the header search box (searchQuery), same as Runtime's
// Services/Ports/Jobs tables — no separate input here.
function sortHeader(label: string, key: ProcessSort['by'], sort: ProcessSort): string {
  const active = sort.by === key
  const arrow = active ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''
  return `<button class="process-sort-header ${active ? 'active' : ''}" data-resource-sort="${key}">${escapeHTML(label)}${arrow}</button>`
}

function renderProcessTable(processes: ProcessInfo[], searchQuery: string, sort: ProcessSort): string {
  const filtered = processes.filter(p => matchesSearch(searchQuery, p.pid, p.user, p.command, p.path, p.project, ...(p.ports || [])))
  if (!filtered.length) {
    return `<div class="empty compact">${processes.length ? 'No processes match your search.' : 'No process info available.'}</div>`
  }
  const sorted = [...filtered].sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1
    if (sort.by === 'pid') return (a.pid - b.pid) * dir
    if (sort.by === 'mem') return (a.mem_percent - b.mem_percent) * dir
    return (a.cpu_percent - b.cpu_percent) * dir
  })
  const capped = !searchQuery && sorted.length > MAX_UNFILTERED_ROWS
  const rows = capped ? sorted.slice(0, MAX_UNFILTERED_ROWS) : sorted
  return `
    <div class="process-table">
      <div class="process-row process-row-head">
        <span class="process-col-pid">${sortHeader('PID', 'pid', sort)}</span>
        <span class="process-col-pct">${sortHeader('CPU', 'cpu', sort)}</span>
        <span class="process-col-pct">${sortHeader('Mem', 'mem', sort)}</span>
        <span class="process-col-user">User</span>
        <span class="process-col-command">Command</span>
        <span class="process-col-path">Path</span>
        <span class="process-col-ports">Ports</span>
        <span class="process-col-project">Project</span>
        <span class="process-col-actions"></span>
      </div>
      ${rows.map(renderProcessRow).join('')}
    </div>
    ${capped ? `<p class="resource-detail">Showing top ${MAX_UNFILTERED_ROWS} of ${sorted.length} processes by ${sort.by.toUpperCase()}. Use search to find a specific one.</p>` : ''}`
}

function renderProcessRow(p: ProcessInfo): string {
  return `
    <div class="process-row">
      <span class="process-col-pid">${p.pid}</span>
      <span class="process-col-pct">${p.cpu_percent.toFixed(1)}%</span>
      <span class="process-col-pct">${p.mem_percent.toFixed(1)}%</span>
      <span class="process-col-user">${escapeHTML(p.user)}</span>
      <span class="process-col-command" title="${escapeHTML(p.command)}">${escapeHTML(p.command || '—')}</span>
      <span class="process-col-path" title="${escapeHTML(p.path)}">${escapeHTML(p.path || '—')}</span>
      <span class="process-col-ports">${p.ports?.length ? escapeHTML(p.ports.join(', ')) : '—'}</span>
      <span class="process-col-project">${p.project ? escapeHTML(p.project) : '—'}</span>
      <span class="process-col-actions">${p.pid > 1 ? `<button class="repo-action danger" data-stop-pid="${p.pid}">Stop</button>` : ''}</span>
    </div>`
}

function meterClass(percent: number): string {
  if (percent >= 90) return 'critical'
  if (percent >= 70) return 'warning'
  return 'healthy'
}

function renderMeterCard(label: string, percent: number, detail: string): string {
  const clamped = Math.max(0, Math.min(100, percent))
  return `
    <article class="resource-card">
      <header><strong>${escapeHTML(label)}</strong><span class="resource-percent">${clamped.toFixed(0)}%</span></header>
      <div class="resource-meter"><div class="resource-meter-fill ${meterClass(clamped)}" style="width: ${clamped}%"></div></div>
      <p class="resource-detail">${escapeHTML(detail)}</p>
    </article>`
}

function renderBatteryCard(snapshot: ResourceSnapshot): string {
  if (!snapshot.battery) {
    return `
      <article class="resource-card">
        <header><strong>Battery</strong></header>
        <p class="resource-detail">No battery detected (desktop Mac).</p>
        ${snapshot.thermal ? `<p class="resource-detail">Thermal: ${escapeHTML(snapshot.thermal)}</p>` : ''}
      </article>`
  }
  const b = snapshot.battery
  return `
    <article class="resource-card">
      <header><strong>Battery</strong><span class="resource-percent">${b.percent}%</span></header>
      <div class="resource-meter"><div class="resource-meter-fill ${b.charging ? 'healthy' : ''}" style="width: ${b.percent}%"></div></div>
      <p class="resource-detail">${escapeHTML(b.power_source)}${b.charging ? ' · charging' : ''}</p>
      ${snapshot.thermal ? `<p class="resource-detail">Thermal: ${escapeHTML(snapshot.thermal)}</p>` : ''}
    </article>`
}

function renderDiskRow(disk: DiskStats): string {
  return `
    <div class="resource-row">
      <span class="resource-row-label">${escapeHTML(disk.mount_point)}</span>
      <div class="resource-meter resource-meter-inline"><div class="resource-meter-fill ${meterClass(disk.used_percent)}" style="width: ${disk.used_percent}%"></div></div>
      <span class="resource-row-detail">${formatBytes(disk.used_bytes)} / ${formatBytes(disk.total_bytes)} (${disk.used_percent.toFixed(0)}%)</span>
    </div>`
}

function formatRate(bytesPerSec: number): string {
  if (!bytesPerSec) return '0 B/s'
  return `${formatBytes(bytesPerSec)}/s`
}

function renderNetworkRow(iface: NetworkInterfaceStats): string {
  return `
    <div class="resource-row">
      <span class="resource-row-label">${escapeHTML(iface.name)}</span>
      <span class="resource-row-detail">↓ ${formatRate(iface.rx_bytes_per_sec)} · ↑ ${formatRate(iface.tx_bytes_per_sec)}</span>
      <span class="resource-row-detail muted">total ${formatBytes(iface.total_rx_bytes)} / ${formatBytes(iface.total_tx_bytes)}</span>
    </div>`
}

function renderGPURow(gpu: GPUInfo): string {
  const parts = [gpu.cores ? `${gpu.cores} cores` : '', gpu.vram ? `${gpu.vram} VRAM` : ''].filter(Boolean)
  return `
    <div class="resource-row">
      <span class="resource-row-label">${escapeHTML(gpu.name)}</span>
      <span class="resource-row-detail">${escapeHTML(parts.join(' · ') || 'Live GPU usage isn\'t available without elevated privileges.')}</span>
    </div>`
}
