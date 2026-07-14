// Managed Logs: one place to tail Docker containers (local + remote via
// SSH), Compose projects, and local processes, instead of digging into
// Runtime/Servers separately for each. Purely a frontend aggregation over
// bindings that already exist elsewhere (ContainerLogs, ProjectLogs,
// ProcessLogs, ServerContainerLogs) — no new backend surface. Like
// utilities.ts, this binds its own events directly instead of going through
// main.ts's shared delegated click handler, since it's a self-contained
// widget that only touches its own state.
import type { Service, ServerConnection } from '../api'
import { api } from '../api'
import { escapeHTML, showError } from '../dom'
import { copyToClipboard } from '../clipboard'

interface LogSource {
  id: string
  label: string
  group: string
  fetch: () => Promise<string>
}

export interface LogsContext {
  services: Service[]
  servers: ServerConnection[]
}

let sourceFilter = ''
let selectedId = ''
let logText = ''
let logErrorText = ''
let searchQuery = ''
let autoRefresh = true
let pollTimer: number | null = null
let serversLoaded = false
let loadingServerContainers = false
// server id -> that server's containers, fetched lazily once when the Logs
// tab is first opened (a burst of parallel SSH calls on an explicit tab
// visit, same cost as opening Servers > Containers per server today).
const serverContainers = new Map<string, { id: string; name: string }[]>()

function buildSources(ctx: LogsContext): LogSource[] {
  const list: LogSource[] = []
  const dockerServices = ctx.services.filter(s => s.source === 'docker' && s.container_id)
  for (const svc of dockerServices) {
    list.push({ id: `container:${svc.container_id}`, label: svc.name, group: 'Docker Containers', fetch: () => api.containerLogs(svc.container_id) })
  }
  const projects = [...new Set(dockerServices.map(s => s.project).filter((p): p is string => !!p))].sort()
  for (const project of projects) {
    list.push({ id: `project:${project}`, label: project, group: 'Compose Projects', fetch: () => api.projectLogs(project) })
  }
  for (const svc of ctx.services.filter(s => s.source === 'process' && s.pid)) {
    list.push({ id: `process:${svc.pid}`, label: svc.name, group: 'Processes', fetch: () => api.processLogs(svc.pid) })
  }
  for (const server of ctx.servers) {
    const containers = serverContainers.get(server.id) || []
    for (const c of containers) {
      list.push({ id: `server:${server.id}:${c.id}`, label: `${c.name} (${server.name})`, group: `Server: ${server.name}`, fetch: () => api.serverContainerLogs(server.id, c.id) })
    }
  }
  return list
}

// Fetches every configured server's container list once, in parallel, the
// first time the Logs tab is opened. Call again (via the "Refresh sources"
// button) if a server's containers changed since.
export async function loadLogSources(ctx: LogsContext): Promise<void> {
  serversLoaded = true
  loadingServerContainers = ctx.servers.length > 0
  renderLogsView(ctx)
  await Promise.all(ctx.servers.map(async server => {
    try {
      const containers = await api.listServerContainers(server.id)
      serverContainers.set(server.id, (containers || []).map(c => ({ id: c.id, name: c.name })))
    } catch {
      serverContainers.set(server.id, [])
    }
  }))
  loadingServerContainers = false
  renderLogsView(ctx)
}

export function initLogsView(ctx: LogsContext): void {
  if (serversLoaded) {
    renderLogsView(ctx)
    return
  }
  void loadLogSources(ctx)
}

export function stopLogsPolling(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPolling(ctx: LogsContext): void {
  stopLogsPolling()
  if (!autoRefresh) return
  pollTimer = window.setInterval(() => void loadSelectedLog(ctx), 4000)
}

function findSource(ctx: LogsContext, id: string): LogSource | undefined {
  return buildSources(ctx).find(s => s.id === id)
}

async function selectSource(ctx: LogsContext, id: string): Promise<void> {
  selectedId = id
  logText = ''
  logErrorText = ''
  renderLogsView(ctx)
  // Opening a source has no prior scroll position to respect — always jump
  // to the newest lines, like `tail -f` would when you first attach it.
  await loadSelectedLog(ctx, true)
  startPolling(ctx)
}

async function loadSelectedLog(ctx: LogsContext, forceScrollToBottom = false): Promise<void> {
  const source = findSource(ctx, selectedId)
  if (!source) return
  // A poll-triggered refresh should only auto-follow the bottom if the user
  // was already there — otherwise it would yank them away from whatever
  // older lines they scrolled up to read.
  const shouldFollow = forceScrollToBottom || isLogScrolledNearBottom()
  try {
    logText = (await source.fetch()) || 'No log output.'
    logErrorText = ''
  } catch (error) {
    logErrorText = String(error)
  }
  updateLogOutputDOM()
  if (shouldFollow) scrollLogToBottom()
}

// Auto-refresh (and the line-filter input) only ever need to touch the log
// text itself — re-running the full renderLogsView every 4s would blow away
// focus on whatever the user is currently typing into.
function updateLogOutputDOM(): void {
  const pre = document.querySelector<HTMLElement>('.logs-output')
  if (pre) pre.innerHTML = renderLogLines(logText, searchQuery)
  const errorHost = document.querySelector<HTMLElement>('.logs-error-slot')
  if (errorHost) errorHost.innerHTML = logErrorText ? `<p class="resource-detail tool-action-failed">${escapeHTML(logErrorText)}</p>` : ''
}

function isLogScrolledNearBottom(): boolean {
  const pre = document.querySelector<HTMLElement>('.logs-output')
  if (!pre) return true
  return pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40
}

function scrollLogToBottom(): void {
  const pre = document.querySelector<HTMLElement>('.logs-output')
  if (pre) pre.scrollTop = pre.scrollHeight
}

function renderLogLines(text: string, query: string): string {
  const lines = (text || '').split('\n')
  const filtered = query.trim() ? lines.filter(l => l.toLowerCase().includes(query.trim().toLowerCase())) : lines
  if (!filtered.length) return '<span class="muted">No matching lines.</span>'
  return filtered.map(line => `<span class="logs-line">${escapeHTML(line) || '&nbsp;'}</span>`).join('')
}

export function renderLogsView(ctx: LogsContext): void {
  const root = document.getElementById('logs-view-body')
  if (!root) return
  const allSources = buildSources(ctx)
  const filtered = sourceFilter.trim()
    ? allSources.filter(s => `${s.label} ${s.group}`.toLowerCase().includes(sourceFilter.trim().toLowerCase()))
    : allSources
  const groups = new Map<string, LogSource[]>()
  for (const s of filtered) {
    const list = groups.get(s.group) || []
    list.push(s)
    groups.set(s.group, list)
  }
  const selected = allSources.find(s => s.id === selectedId)
  // Selecting an item re-renders this whole panel, which would otherwise
  // reset the sidebar list's scroll back to the top — jarring when the
  // item just clicked was further down the list.
  const sidebarScrollTop = root.querySelector('.logs-source-list')?.scrollTop ?? 0

  root.innerHTML = `
    <div class="logs-layout">
      <div class="logs-sidebar">
        <div class="logs-sidebar-toolbar">
          <input id="logs-source-filter" class="search-input" type="search" placeholder="Filter sources..." value="${escapeHTML(sourceFilter)}">
          <button class="btn-icon" id="logs-refresh-sources-btn" title="Refresh sources">↻</button>
        </div>
        <div class="logs-source-list">
          ${allSources.length === 0 && !loadingServerContainers ? '<div class="empty compact">No log sources found. Start a container, or add a server in Servers.</div>' : ''}
          ${[...groups.entries()].map(([group, list]) => `
            <div class="logs-source-group">${escapeHTML(group)}</div>
            ${list.map(s => `<button class="logs-source-item ${s.id === selectedId ? 'active' : ''}" data-logs-select="${escapeHTML(s.id)}">${escapeHTML(s.label)}</button>`).join('')}
          `).join('')}
          ${loadingServerContainers ? '<div class="empty compact">Loading server containers…</div>' : ''}
        </div>
      </div>
      <div class="logs-detail">
        ${!selected ? '<div class="empty compact">Pick a log source from the list.</div>' : `
          <div class="logs-toolbar">
            <strong>${escapeHTML(selected.label)}</strong>
            <input id="logs-search" class="search-input" type="search" placeholder="Filter lines..." value="${escapeHTML(searchQuery)}">
            <label class="settings-checkbox"><input type="checkbox" id="logs-autorefresh" ${autoRefresh ? 'checked' : ''}> Auto-refresh</label>
            <button class="btn-secondary" id="logs-refresh-btn">Refresh</button>
            <button class="btn-secondary" id="logs-copy-btn">Copy</button>
          </div>
          <div class="logs-error-slot">${logErrorText ? `<p class="resource-detail tool-action-failed">${escapeHTML(logErrorText)}</p>` : ''}</div>
          <pre class="logs-output">${renderLogLines(logText, searchQuery)}</pre>
        `}
      </div>
    </div>`

  const sidebarList = root.querySelector('.logs-source-list')
  if (sidebarList) sidebarList.scrollTop = sidebarScrollTop

  document.getElementById('logs-source-filter')?.addEventListener('input', event => {
    sourceFilter = (event.target as HTMLInputElement).value
    const cursor = (event.target as HTMLInputElement).selectionStart
    renderLogsView(ctx)
    // Same fix as envFiles.ts: this input is part of the innerHTML that
    // just got replaced, so it loses focus every keystroke unless restored.
    const newInput = document.getElementById('logs-source-filter') as HTMLInputElement | null
    if (newInput) {
      newInput.focus()
      if (cursor !== null) newInput.setSelectionRange(cursor, cursor)
    }
  })
  document.getElementById('logs-refresh-sources-btn')?.addEventListener('click', () => void loadLogSources(ctx))
  root.querySelectorAll<HTMLButtonElement>('[data-logs-select]').forEach(btn => {
    btn.addEventListener('click', () => void selectSource(ctx, btn.dataset.logsSelect || ''))
  })
  document.getElementById('logs-search')?.addEventListener('input', event => {
    searchQuery = (event.target as HTMLInputElement).value
    updateLogOutputDOM()
  })
  document.getElementById('logs-autorefresh')?.addEventListener('change', event => {
    autoRefresh = (event.target as HTMLInputElement).checked
    if (autoRefresh) startPolling(ctx)
    else stopLogsPolling()
  })
  document.getElementById('logs-refresh-btn')?.addEventListener('click', () => void loadSelectedLog(ctx))
  document.getElementById('logs-copy-btn')?.addEventListener('click', () => {
    void copyToClipboard(logText, 'Managed Logs').catch(error => showError(String(error)))
  })
}
