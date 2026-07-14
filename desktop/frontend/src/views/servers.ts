// Remote Servers: SSH-based management of servers you've configured by
// hand (host/user/port/key path — never the key's contents). CheckServer
// is read-only (uptime/memory/disk/docker status), parsed into structured
// fields on a best-effort basis (see desktop/servers.go). The terminal is a
// real interactive PTY-backed SSH session (see ../serverTerminal.ts) —
// like the terminal session you'd otherwise open by hand for this box, it
// is intentionally not gated behind a confirm-per-keystroke/command
// dialog. Container start/stop/restart on a remote server DO ask for
// confirmation first, the same as their local Docker equivalents. Cron jobs
// are read via `crontab -l` (parsed with the same internal/cron logic the
// local Jobs tab uses); enabling/disabling/removing a line edits that same
// raw crontab text by line number and writes it back — both require
// confirmation, like the other remote-mutating actions here.
import type { ServerConnection, ServerHealth, RemoteContainer, CronJob, SSHConfigHost, RemoteFile } from '../api'
import type { ServerTerminalStatus } from '../serverTerminal'
import { escapeHTML, formatBytes } from '../dom'
import { t } from '../i18n'

export interface ServerTerminalState {
  serverId: string
  status: ServerTerminalStatus
  detail?: string
}

export interface ServerContainersState {
  status: 'loading' | 'loaded' | 'error'
  items: RemoteContainer[]
  error?: string
  logs?: { containerId: string; text: string } | null
}

export interface ServerCronState {
  status: 'loading' | 'loaded' | 'error'
  items: CronJob[]
  error?: string
}

export interface ServersViewState {
  servers: ServerConnection[]
  checks: Map<string, ServerHealth | 'checking'>
  keyWarnings: Map<string, string>
  terminal: ServerTerminalState | null
  containers: Map<string, ServerContainersState>
  cron: Map<string, ServerCronState>
  files: Map<string, ServerFilesState>
  showAddForm: boolean
  editingServer: ServerConnection | null
  sshConfigHosts?: SSHConfigHost[]
  selectedServers: Set<string>
  bulkRun: ServerBulkRunState | null
}

export interface ServerFilesState {
  path: string
  status: 'loading' | 'loaded' | 'error'
  items: RemoteFile[]
  error?: string
  transfer?: { kind: 'upload' | 'download'; name: string; running: boolean; error?: string } | null
}

export interface ServerBulkRunJobStatus {
  serverId: string
  serverName: string
  running: boolean
  output: string
  error?: string
}

export interface ServerBulkRunState {
  command: string
  jobs: ServerBulkRunJobStatus[]
}

const ENVIRONMENTS = ['production', 'staging', 'dev']

export function renderServersView(state: ServersViewState): void {
  const container = document.getElementById('servers-content')
  if (!container) return

  container.innerHTML = `
    <div class="servers-toolbar">
      <button class="btn-secondary" data-server-add-toggle>${state.showAddForm ? t('Cancel') : t('Add server')}</button>
      ${state.servers.length ? renderBulkRunToolbar(state) : ''}
    </div>

    ${state.servers.length ? renderServersSummary(state) : ''}

    ${state.showAddForm ? renderServerForm(undefined, state.sshConfigHosts) : ''}
    ${state.editingServer ? renderServerForm(state.editingServer) : ''}

    ${state.bulkRun ? renderBulkRunPanel(state.bulkRun) : ''}

    ${state.servers.length ? '' : `<div class="empty compact">${t('No servers configured yet. Add one with its host, SSH user, and .pem key path.')}</div>`}

    <div class="resource-list servers-list">
      ${state.servers.map(s => renderServerRow(s, state)).join('')}
    </div>
  `
}

// Selecting servers here doesn't do anything by itself — it's paired with
// the "Run on N servers" button, which fans a single command out to
// RunServerCommand for each selected server (see handleServerBulkRunSubmit
// in main.ts). Kept separate from the per-row Terminal action, which is for
// one server's real interactive session.
function renderBulkRunToolbar(state: ServersViewState): string {
  const count = state.selectedServers.size
  return `
    <label class="server-bulk-select-all">
      <input type="checkbox" data-server-select-all ${count > 0 && count === state.servers.length ? 'checked' : ''}>
      <span>${t('Select all')}</span>
    </label>
    <button class="btn-secondary" data-server-bulk-run-toggle ${count ? '' : 'disabled'}>${t('Run on')} ${count} ${t(count === 1 ? 'server' : 'servers')}</button>`
}

function renderBulkRunPanel(state: ServerBulkRunState): string {
  if (!state.jobs.length) {
    return `
      <div class="server-bulk-run-panel">
        <label class="server-add-field">
          <span>${t('Command to run on every selected server')}</span>
          <input class="search-input" data-server-bulk-run-command placeholder="${t('e.g. docker compose pull')}" value="${escapeHTML(state.command)}">
        </label>
        <div class="server-add-buttons">
          <button class="btn-primary" data-server-bulk-run-submit>${t('Run')}</button>
          <button class="btn-secondary" data-server-bulk-run-cancel>${t('Cancel')}</button>
        </div>
      </div>`
  }
  return `
    <div class="server-bulk-run-panel">
      <div class="server-add-buttons"><button class="btn-secondary" data-server-bulk-run-cancel>${t('Close')}</button></div>
      ${state.jobs.map(job => `
        <div class="server-bulk-run-job">
          <div class="server-bulk-run-job-header">
            <strong>${escapeHTML(job.serverName)}</strong>
            ${job.running
              ? `<span class="resource-detail muted">${t('Running…')}</span>`
              : job.error
                ? `<span class="resource-detail tool-action-failed">${escapeHTML(job.error)}</span>`
                : `<span class="status-badge status-healthy">${t('Done')}</span>`}
          </div>
          <pre class="tool-action-output">${escapeHTML(job.output || t('(no output yet)'))}</pre>
        </div>`).join('')}
    </div>`
}

// Servers are checked automatically as soon as this tab opens (see
// loadServers in main.ts), so the average figures below are usually
// populated within a second or two rather than requiring a manual Check
// click first.
function renderServersSummary(state: ServersViewState): string {
  let online = 0
  let offline = 0
  const cpu: number[] = []
  const mem: number[] = []
  const disk: number[] = []
  for (const s of state.servers) {
    const check = state.checks.get(s.id)
    if (!check || check === 'checking') continue
    if (!check.reachable) {
      offline++
      continue
    }
    online++
    if (check.cpu_percent >= 0) cpu.push(check.cpu_percent)
    if (check.mem_percent >= 0) mem.push(check.mem_percent)
    if (check.disk_percent >= 0) disk.push(check.disk_percent)
  }
  const avg = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null

  const summaryCard = (label: string, avgValue: number[] | number | null, sampleCount?: number) => {
    const value = Array.isArray(avgValue) ? avg(avgValue) : avgValue
    const stateClass = typeof value === 'number' ? (value >= 90 ? ' danger' : value >= 70 ? ' warning' : '') : ''
    const detail = sampleCount === undefined
      ? `${online} ${t('online')} · ${offline} ${t('offline')}`
      : `${t('Avg across')} ${sampleCount} ${t(sampleCount === 1 ? 'checked server' : 'checked servers')}`
    return `
      <div class="stat-card${stateClass}">
        <span>${label}</span>
        <strong>${value === null ? '—' : Array.isArray(avgValue) ? `${value}%` : value}</strong>
        <p class="resource-detail muted">${detail}</p>
      </div>`
  }

  return `
    <div class="stats servers-summary">
      ${summaryCard(t('Total Servers'), state.servers.length)}
      ${summaryCard(t('Avg CPU Usage'), cpu, cpu.length)}
      ${summaryCard(t('Avg Memory Usage'), mem, mem.length)}
      ${summaryCard(t('Avg Disk Usage'), disk, disk.length)}
    </div>`
}

// Shared by both Add and Edit: passing an existing server pre-fills the
// fields and swaps the submit button for data-server-edit-submit (handled
// by handleUpdateServer in main.ts) instead of data-server-add-submit.
function renderServerForm(server?: ServerConnection, sshConfigHosts?: SSHConfigHost[]): string {
  const isEdit = Boolean(server)
  return `
    <div class="server-add-form">
      <p class="server-add-notice">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        ${t("Only the key file's path is saved — Thaloca never reads or copies its contents. SSH itself reads the key directly from disk when connecting. The first connection to a new host auto-trusts its key (still fails later if that key ever changes).")}
      </p>
      ${!isEdit ? renderSSHConfigImport(sshConfigHosts) : ''}
      <div class="server-add-grid">
        <label class="server-add-field">
          <span>${t('Name')}</span>
          <input class="search-input" data-field="name" placeholder="${t('Optional, defaults to host')}" value="${escapeHTML(server?.name || '')}">
        </label>
        <label class="server-add-field">
          <span>${t('Host')}</span>
          <input class="search-input" data-field="host" placeholder="1.2.3.4 or my.server.com" value="${escapeHTML(server?.host || '')}">
        </label>
        <label class="server-add-field server-add-field-narrow">
          <span>${t('Port')}</span>
          <input class="search-input" data-field="port" placeholder="22" type="number" value="${server?.port ? escapeHTML(String(server.port)) : ''}">
        </label>
        <label class="server-add-field">
          <span>${t('SSH user')}</span>
          <input class="search-input" data-field="user" placeholder="${t('e.g. ubuntu')}" value="${escapeHTML(server?.user || '')}">
        </label>
        <label class="server-add-field server-add-field-narrow">
          <span>${t('Environment')}</span>
          <select class="search-input" data-field="environment">
            <option value="">${t('None')}</option>
            ${ENVIRONMENTS.map(e => `<option value="${e}" ${server?.environment === e ? 'selected' : ''}>${e[0].toUpperCase()}${e.slice(1)}</option>`).join('')}
          </select>
        </label>
        <label class="server-add-field server-add-field-wide">
          <span>${t('Private key file')}</span>
          <div class="server-add-key-row">
            <input class="search-input" data-field="keyPath" placeholder="/path/to/key.pem" value="${escapeHTML(server?.key_path || '')}" readonly>
            <button class="btn-secondary" data-server-browse-key>${t('Browse…')}</button>
          </div>
        </label>
        <label class="server-add-field server-add-field-wide">
          <span>${t('Bastion / ProxyJump host (optional)')}</span>
          <input class="search-input" data-field="proxyJump" placeholder="e.g. jump@bastion.example.com" value="${escapeHTML(server?.proxy_jump || '')}">
        </label>
      </div>
      <div class="server-add-buttons">
        <button class="btn-secondary" data-server-check-draft>${t('Check')}</button>
        ${isEdit
          ? `<button class="btn-primary" data-server-edit-submit="${escapeHTML(server!.id)}">${t('Save changes')}</button>
             <button class="btn-secondary" data-server-edit-cancel>${t('Cancel')}</button>`
          : `<button class="btn-primary" data-server-add-submit>${t('Save server')}</button>`}
      </div>
      <div class="server-add-check-result" data-server-check-result></div>
    </div>`
}

// Optional helper above the Add Server fields: pick a Host entry already
// defined in ~/.ssh/config to prefill the fields below instead of typing
// them by hand. Purely a prefill — nothing is saved until "Save server" is
// clicked, same as filling the fields in any other way.
function renderSSHConfigImport(hosts?: SSHConfigHost[]): string {
  if (hosts === undefined) {
    return `
      <div class="server-ssh-config-import">
        <button class="btn-secondary" data-server-ssh-config-load>${t('Import from ~/.ssh/config')}</button>
      </div>`
  }
  if (!hosts.length) {
    return `<p class="resource-detail muted">${t('No usable entries found in ~/.ssh/config.')}</p>`
  }
  return `
    <div class="server-ssh-config-import">
      <label class="server-add-field">
        <span>${t('Import from ~/.ssh/config')}</span>
        <select class="search-input" data-server-ssh-config-pick>
          <option value="">${t('Choose a host…')}</option>
          ${hosts.map((h, i) => `<option value="${i}">${escapeHTML(h.alias)} (${escapeHTML(h.user || '?')}@${escapeHTML(h.host)})</option>`).join('')}
        </select>
      </label>
    </div>`
}

function renderServerRow(s: ServerConnection, state: ServersViewState): string {
  const check = state.checks.get(s.id)
  const checking = check === 'checking'
  const health = check && !checking ? check : null
  const terminalOpen = state.terminal?.serverId === s.id
  const containers = state.containers.get(s.id)
  const cron = state.cron.get(s.id)
  const files = state.files.get(s.id)
  const keyWarning = state.keyWarnings.get(s.id)

  const statusClass = checking ? 'checking' : health ? (health.reachable ? 'online' : 'offline') : 'unknown'
  const statusLabel = checking ? t('Checking…') : health ? (health.reachable ? t('Online') : t('Offline')) : t('Not checked yet')
  const containerCount = health?.reachable && health.docker_available ? health.containers.length : 0

  return `
    <div class="server-row">
      <div class="server-row-main">
        <div class="server-row-identity">
          <input type="checkbox" class="server-row-select" data-server-select="${escapeHTML(s.id)}" ${state.selectedServers.has(s.id) ? 'checked' : ''}>
          <span class="server-status-dot server-status-${statusClass}" title="${escapeHTML(statusLabel)}"></span>
          <div>
            <div class="server-row-name">
              <strong>${escapeHTML(s.name)}</strong>
              ${s.environment ? `<span class="env-badge env-badge-${escapeHTML(s.environment)}">${escapeHTML(s.environment)}</span>` : ''}
            </div>
            <span class="resource-detail muted">${escapeHTML(s.user)}@${escapeHTML(s.host)}:${s.port}</span>
          </div>
        </div>

        <div class="server-row-metrics">
          ${renderServerMetric(t('CPU'), health, health?.cpu_percent, checking)}
          ${renderServerMetric(t('Memory'), health, health?.mem_percent, checking)}
          ${renderServerMetric(t('Disk'), health, health?.disk_percent, checking)}
        </div>

        <div class="server-row-uptime">
          <span class="resource-detail muted">${t('Uptime')}</span>
          <strong>${health?.reachable && health.uptime ? escapeHTML(formatUptime(health.uptime)) : '—'}</strong>
        </div>

        <div class="server-row-actions">
          <button class="btn-icon-sm" data-server-check="${escapeHTML(s.id)}" title="${t('Re-check')}" ${checking ? 'disabled' : ''}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 22v-6h6M21 8A9 9 0 0 0 6.4 5.6L3 8m18 8a9 9 0 0 1-14.6 2.4L3 16"/></svg>
          </button>
          <button class="btn-icon-sm" data-server-containers-toggle="${escapeHTML(s.id)}" title="${containers ? t('Hide containers') : t('Containers')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="7" rx="1.5"/><rect x="2" y="14" width="20" height="7" rx="1.5"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/></svg>
            ${containerCount ? `<span class="server-action-badge">${containerCount}</span>` : ''}
          </button>
          <button class="btn-icon-sm" data-server-terminal-toggle="${escapeHTML(s.id)}" title="${terminalOpen ? t('Close terminal') : t('Terminal')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </button>
          <button class="btn-icon-sm" data-server-cron-toggle="${escapeHTML(s.id)}" title="${cron ? t('Hide cron jobs') : t('Cron jobs')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            ${cron?.status === 'loaded' && cron.items.length ? `<span class="server-action-badge">${cron.items.length}</span>` : ''}
          </button>
          <button class="btn-icon-sm" data-server-files-toggle="${escapeHTML(s.id)}" title="${files ? t('Hide files') : t('Files')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </button>
          <details class="server-row-menu">
            <summary class="btn-icon-sm" title="${t('More actions')}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
            </summary>
            <div class="server-row-menu-panel">
              <button data-server-edit-toggle="${escapeHTML(s.id)}">${t('Edit')}</button>
              <button class="danger" data-server-remove="${escapeHTML(s.id)}">${t('Remove')}</button>
            </div>
          </details>
        </div>
      </div>

      ${keyWarning ? `
        <div class="server-key-warning">
          <span class="resource-detail tool-action-failed">${escapeHTML(keyWarning)}</span>
          <button class="btn-secondary" data-server-fix-key="${escapeHTML(s.id)}">${t('Fix permissions')}</button>
        </div>` : ''}
      ${health && !health.reachable ? renderUnreachableNote(health) : ''}
      ${containers ? renderContainersPanel(s.id, containers) : ''}
      ${cron ? renderCronPanel(s.id, cron) : ''}
      ${files ? renderFilesPanel(s.id, files) : ''}
      ${terminalOpen && state.terminal ? renderTerminalPanel(state.terminal) : ''}
    </div>`
}

function renderCronPanel(serverId: string, state: ServerCronState): string {
  if (state.status === 'loading') {
    return `<div class="server-cron"><div class="empty compact">${t('Reading crontab…')}</div></div>`
  }
  if (state.status === 'error') {
    return `<div class="server-cron"><p class="resource-detail tool-action-failed">${escapeHTML(state.error || t('Failed to read crontab.'))}</p></div>`
  }
  if (!state.items.length) {
    return `<div class="server-cron"><div class="empty compact">${t("No cron jobs in this user's crontab.")}</div></div>`
  }
  return `
    <div class="server-cron">
      ${state.items.map(job => `
        <div class="server-cron-row${job.disabled ? ' server-cron-row-disabled' : ''}">
          <code class="server-cron-schedule">${escapeHTML(job.schedule)}</code>
          <code class="server-cron-command">${escapeHTML(job.command)}</code>
          ${job.disabled ? `<span class="status-badge status-down">${t('disabled')}</span>` : ''}
          <div class="server-cron-actions">
            <button class="btn-secondary" data-server-cron-set-enabled="${escapeHTML(serverId)}" data-cron-line="${job.line}" data-cron-enabled="${job.disabled ? '1' : '0'}">${job.disabled ? t('Enable') : t('Disable')}</button>
            <button class="btn-secondary danger" data-server-cron-remove="${escapeHTML(serverId)}" data-cron-line="${job.line}">${t('Remove')}</button>
          </div>
        </div>`).join('')}
    </div>`
}

// health is passed in (rather than just the percent) so a server that
// hasn't been checked yet ("Not checked yet") reads differently from one
// whose check succeeded but didn't yield that particular figure (-1).
function renderServerMetric(label: string, health: ServerHealth | null, percent: number | undefined, checking: boolean): string {
  if (checking) {
    return `
      <div class="server-metric">
        <span class="resource-detail muted">${label}</span>
        <div class="resource-meter"><div class="resource-meter-fill checking"></div></div>
      </div>`
  }
  if (!health || !health.reachable || percent === undefined || percent < 0) {
    return `
      <div class="server-metric">
        <span class="resource-detail muted">${label}</span>
        <span class="resource-detail muted server-metric-empty">—</span>
      </div>`
  }
  const clamped = Math.min(100, Math.max(0, percent))
  const level = clamped >= 90 ? 'critical' : clamped >= 70 ? 'warning' : 'healthy'
  return `
    <div class="server-metric">
      <div class="server-metric-label"><span class="resource-detail muted">${label}</span><span class="resource-percent">${clamped}%</span></div>
      <div class="resource-meter"><div class="resource-meter-fill ${level}" style="width:${clamped}%"></div></div>
    </div>`
}

// Turns raw `uptime` output ("11:42  up 2 days, 22:10, 3 users, load
// averages: 1.23 1.10 1.05" on macOS, "11:42:01 up 2 days,  3:04,  2
// users,  load average: 0.01, 0.02, 0.00" on Linux) into just "2 days,
// 22:10" — the full line is too long for a compact column.
function formatUptime(raw: string): string {
  const match = raw.match(/up\s+(.+?),\s*\d+\s*users?\b/i)
  return match ? match[1].trim() : raw.trim()
}

function renderUnreachableNote(health: ServerHealth): string {
  return `
    <div class="server-unreachable">
      <span class="resource-detail tool-action-failed">${t('Unreachable')}${health.error ? ': ' + escapeHTML(health.error) : ''}</span>
      ${health.raw ? `
        <details class="server-raw-details">
          <summary>${t('Show raw output')}</summary>
          <pre class="tool-action-output server-check-output">${escapeHTML(health.raw)}</pre>
        </details>` : ''}
    </div>`
}

function renderContainersPanel(serverId: string, state: ServerContainersState): string {
  if (state.status === 'loading') {
    return `<div class="server-containers"><div class="empty compact">${t('Loading containers…')}</div></div>`
  }
  if (state.status === 'error') {
    return `<div class="server-containers"><p class="resource-detail tool-action-failed">${escapeHTML(state.error || t('Failed to load containers.'))}</p></div>`
  }
  if (!state.items.length) {
    return `<div class="server-containers"><div class="empty compact">${t('No containers found on this server.')}</div></div>`
  }
  return `
    <div class="server-containers">
      ${state.items.map(c => `
        <div class="server-container-row">
          <div class="server-container-info">
            <strong>${escapeHTML(c.name)}</strong>
            <span class="resource-detail muted">${escapeHTML(c.image)}</span>
          </div>
          <span class="status-badge status-${c.state === 'running' ? 'healthy' : 'down'}">${escapeHTML(c.status)}</span>
          <div class="server-container-actions">
            ${c.state === 'running'
              ? `<button class="btn-secondary" data-server-container-stop="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">${t('Stop')}</button>
                 <button class="btn-secondary" data-server-container-restart="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">${t('Restart')}</button>`
              : `<button class="btn-secondary" data-server-container-start="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">${t('Start')}</button>`}
            <button class="btn-secondary" data-server-container-logs="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">${t('Logs')}</button>
          </div>
        </div>
        ${state.logs?.containerId === c.id ? `<pre class="tool-action-output">${escapeHTML(state.logs.text || t('(no output)'))}</pre>` : ''}
      `).join('')}
    </div>`
}

// Directory browsing + upload/download over the same server, shelling out
// to `scp` (see desktop/serverFileTransfer.go) rather than a Go SFTP
// library — consistent with the rest of this tab, which always defers to
// the system ssh/scp binaries instead of vendoring SSH logic.
function renderFilesPanel(serverId: string, state: ServerFilesState): string {
  const transferBanner = state.transfer
    ? `<p class="resource-detail ${state.transfer.running ? 'muted' : state.transfer.error ? 'tool-action-failed' : ''}">
        ${state.transfer.kind === 'upload' ? t('Uploading') : t('Downloading')} "${escapeHTML(state.transfer.name)}"${state.transfer.running ? '…' : state.transfer.error ? `: ${escapeHTML(state.transfer.error)}` : ` — ${t('done')}`}
      </p>`
    : ''

  const body = state.status === 'loading'
    ? `<div class="empty compact">${t('Loading files…')}</div>`
    : state.status === 'error'
      ? `<p class="resource-detail tool-action-failed">${escapeHTML(state.error || t('Failed to list files.'))}</p>`
      : !state.items.length
        ? `<div class="empty compact">${t('Empty directory.')}</div>`
        : `
          <div class="server-files-list">
            ${state.items.map(f => `
              <div class="server-file-row">
                ${f.is_dir
                  ? `<button class="server-file-name server-file-dir" data-server-file-nav="${escapeHTML(serverId)}" data-file-path="${escapeHTML(joinFilePath(state.path, f.name))}">${escapeHTML(f.name)}/</button>`
                  : `<span class="server-file-name">${escapeHTML(f.name)}</span>`}
                <span class="resource-detail muted">${f.is_dir ? '' : escapeHTML(formatBytes(f.size))}</span>
                <span class="resource-detail muted">${f.mod_time ? escapeHTML(new Date(f.mod_time * 1000).toLocaleString()) : ''}</span>
                ${!f.is_dir ? `<button class="btn-secondary" data-server-file-download="${escapeHTML(serverId)}" data-file-name="${escapeHTML(f.name)}">${t('Download')}</button>` : ''}
              </div>`).join('')}
          </div>`

  return `
    <div class="server-files">
      <div class="server-files-toolbar">
        <div class="server-files-breadcrumb">${renderFileBreadcrumb(serverId, state.path)}</div>
        <button class="btn-secondary" data-server-file-upload="${escapeHTML(serverId)}">${t('Upload here…')}</button>
      </div>
      ${transferBanner}
      ${body}
    </div>`
}

function joinFilePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

function renderFileBreadcrumb(serverId: string, path: string): string {
  const segments = path ? path.split('/') : []
  const crumbs = [{ label: '~', path: '' }, ...segments.map((seg, i) => ({ label: seg, path: segments.slice(0, i + 1).join('/') }))]
  return crumbs.map(c => `<button class="server-file-breadcrumb" data-server-file-nav="${escapeHTML(serverId)}" data-file-path="${escapeHTML(c.path)}">${escapeHTML(c.label)}</button>`).join('<span class="resource-detail muted"> / </span>')
}

function renderTerminalPanel(state: ServerTerminalState): string {
  const statusLabel = state.status === 'connecting' ? t('Connecting…') : state.status === 'open' ? t('Connected') : t('Closed')
  return `
    <div class="server-terminal">
      <div class="server-terminal-toolbar">
        <span class="resource-detail server-terminal-status server-terminal-status-${state.status}">${statusLabel}</span>
        ${state.detail ? `<span class="resource-detail tool-action-failed">${escapeHTML(state.detail)}</span>` : ''}
      </div>
      <div class="server-terminal-surface" data-server-terminal-mount="${escapeHTML(state.serverId)}"></div>
    </div>`
}
