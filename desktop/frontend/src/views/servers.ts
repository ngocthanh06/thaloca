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
import type { ServerConnection, ServerHealth, RemoteContainer, CronJob, SSHConfigHost, RemoteFile, ServerVPNStatus, VPNEngineInfo } from '../api'
import type { ServerTerminalStatus } from '../serverTerminal'
import { escapeHTML, formatBytes } from '../dom'
import { t } from '../i18n'
import { HOMEBREW_BLOCKED_REASON } from './tools'

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
  vpn: Map<string, ServerVPNPanelState>
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

// VPN config values are never read back out of Thaloca once saved (see
// desktop/serverVPN.go — there is no "get" RPC, only "set"), the same
// hide-until-explicit-reveal posture Env Files already takes with secret
// values, so `editing` always starts blank — entering a new config always
// replaces whatever (if anything) was saved before. Every field's value
// lives only in the DOM (read at Save time, same as the Add/Edit Server
// form's own fields) rather than tracked here on every keystroke.
// `engines`/`selectedEngine` drive which VPN protocol's fields (privateKey,
// address, ... for WireGuard vs ovpnConfig, username, ... for OpenVPN)
// render — entirely data-driven from ListVPNEngines rather than
// hardcoded per protocol, so a 3rd engine needs no frontend changes here.
export interface ServerVPNPanelState {
  status: ServerVPNStatus | null // null while the initial status fetch is in flight
  engines: VPNEngineInfo[] | null // fetched once when the panel first opens
  selectedEngine: string | null // engine kind chosen for the guided form
  editing: boolean
  busy: 'saving' | 'connecting' | 'disconnecting' | 'removing' | ''
  error?: string
  // Live output while installing a not-yet-installed engine's CLI tool
  // from the picker (same RunToolAction/confirm/poll flow the Tools tab
  // uses), so the user isn't forced to switch tabs just to install it.
  installing?: { name: string; output: string; running: boolean; exitCode: number; error?: string }
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
  const vpn = state.vpn.get(s.id)
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
          <button class="btn-icon-sm" data-server-vpn-toggle="${escapeHTML(s.id)}" title="${vpn ? t('Hide VPN') : t('VPN')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
            ${s.vpn_enabled ? `<span class="server-action-badge">${t('VPN')}</span>` : ''}
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
      ${vpn ? renderVPNPanel(s, vpn) : ''}
      ${terminalOpen && state.terminal ? renderTerminalPanel(state.terminal) : ''}
    </div>`
}

// One input per WireGuard setting, grouped and sized the same way the
// Add/Edit Server grid already does (long secrets get their own full-width
// row, short paired values like Address/DNS share one) — so filling this
// in doesn't require already knowing the .conf file's [Interface]/[Peer]
// section syntax, and doesn't just read as one long column either.
// buildWireGuardConfig (in main.ts) assembles these into the actual config
// text at Save time. Field lists themselves come from ListVPNEngines (see
// desktop/serverVPN.go's vpnEngine.fields()) rather than being hardcoded
// here — a 3rd engine needs no changes to this file.

// VPN config is set-only (see ServerVPNPanelState's doc comment) — every
// field starts empty, whether adding a config for the first time or
// replacing an existing one.
function renderVPNPanel(server: ServerConnection, state: ServerVPNPanelState): string {
  const serverId = server.id
  if (!state.status || !state.engines) {
    return `<div class="server-vpn"><div class="empty compact">${t('Checking VPN status…')}</div></div>`
  }
  const { configured, connected } = state.status
  const configuredEngine = state.engines.find(e => e.kind === server.vpn_type)
  const statusBadge = connected
    ? `<span class="status-badge status-healthy">${t('Connected')}</span>`
    : configured
      ? `<span class="status-badge status-unknown">${t('Configured — disconnected')}</span>`
      : `<span class="status-badge status-down">${t('Not configured')}</span>`
  const busy = state.busy !== ''

  return `
    <div class="server-vpn">
      <div class="server-vpn-status">
        <strong>${t('VPN')}</strong>
        ${configured && configuredEngine ? `<span class="resource-detail muted">${escapeHTML(configuredEngine.name)}</span>` : ''}
        ${statusBadge}
      </div>
      <p class="resource-detail muted">${configured && server.vpn_type === 'system'
        ? t('This server is linked to a VPN managed by macOS. Connect/Disconnect switches that VPN for the whole Mac — no admin password needed.')
        : t('Some servers only answer SSH once their VPN tunnel is up. Set it up below, then Connect before checking/using it. WireGuard/OpenVPN tunnels need an admin password each time — Thaloca never stores it.')}</p>
      ${(state.status?.shared_with || []).length ? `<p class="resource-detail muted">${t('Also linked to:')} ${escapeHTML((state.status?.shared_with || []).join(', '))}</p>` : ''}
      ${state.error ? `<p class="resource-detail tool-action-failed">${escapeHTML(state.error)}</p>` : ''}

      ${state.editing ? renderVPNEditing(serverId, state) : `
        <div class="server-vpn-actions">
          <button class="btn-secondary" data-server-vpn-edit-start="${escapeHTML(serverId)}" ${busy || connected ? 'disabled' : ''} title="${connected ? t('Disconnect first') : ''}">${configured ? t('Replace config') : t('Add VPN config')}</button>
          ${configured ? `
            <button class="btn-secondary" data-server-vpn-connect-toggle="${escapeHTML(serverId)}" data-vpn-connected="${connected ? '1' : '0'}" ${busy ? 'disabled' : ''}>
              ${state.busy === 'connecting' ? t('Connecting…') : state.busy === 'disconnecting' ? t('Disconnecting…') : connected ? t('Disconnect') : t('Connect')}
            </button>
            <button class="btn-secondary danger" data-server-vpn-remove="${escapeHTML(serverId)}" ${busy || connected ? 'disabled' : ''} title="${connected ? t('Disconnect first') : ''}">${state.busy === 'removing' ? t('Removing…') : t('Remove config')}</button>` : ''}
        </div>`}
    </div>`
}

// renderVPNInstallBlocked shows, as visible text below the engine picker,
// why a missing engine can't be installed from here (currently only:
// Homebrew itself is missing) — mirroring the Tools tab, which also offers
// its existing Install Homebrew flow (the global data-open-homebrew-install
// handler) for that one reason with a concrete next step.
function renderVPNInstallBlocked(engines: VPNEngineInfo[]): string {
  const reason = engines.find(e => !e.installed && !e.install_command && e.install_blocked_reason)?.install_blocked_reason
  if (!reason) return ''
  return `
    <div class="server-vpn-install-blocked">
      <p class="resource-detail muted">${escapeHTML(t(reason))}</p>
      ${reason === HOMEBREW_BLOCKED_REASON ? `<button class="btn-secondary" data-open-homebrew-install>${t('Install Homebrew…')}</button>` : ''}
    </div>`
}

// The engine picker always stays visible above the selected engine's fields,
// so switching between WireGuard and OpenVPN never requires cancelling or
// reopening the form. Fields remain generic from each VPNFieldDef list.
function renderVPNEditing(serverId: string, state: ServerVPNPanelState): string {
  const busy = state.busy !== ''
  const engines = state.engines || []

  const installing = state.installing
  const enginePicker = `
    <div class="server-vpn-engine-picker">
      ${engines.map(e => {
        if (e.installed) {
          return `<button class="btn-secondary${state.selectedEngine === e.kind ? ' active' : ''}" data-server-vpn-select-engine="${escapeHTML(serverId)}" data-vpn-engine="${escapeHTML(e.kind)}" aria-pressed="${state.selectedEngine === e.kind ? 'true' : 'false'}" ${busy ? 'disabled' : ''}>${escapeHTML(e.name)}</button>`
        }
        // No install command means the installer itself (Homebrew) is
        // missing — the visible explanation (and the Install Homebrew
        // button) is rendered below the picker, since a disabled button's
        // tooltip is not reliably reachable (see ListVPNEngines).
        if (!e.install_command) {
          return `<button class="btn-secondary" disabled>
            ${escapeHTML(e.name)} (${t('not installed')})
          </button>`
        }
        return `<button class="btn-secondary" data-server-vpn-install-engine="${escapeHTML(serverId)}" data-vpn-engine="${escapeHTML(e.kind)}" data-vpn-binary="${escapeHTML(e.binary)}" data-vpn-name="${escapeHTML(e.name)}" data-vpn-install-command="${escapeHTML(e.install_command)}" ${busy || installing?.running ? 'disabled' : ''} title="${t('Click to install')}">
            ${escapeHTML(e.name)} (${t('not installed')} — ${t('click to install')})
          </button>`
      }).join('')}
    </div>
    ${renderVPNInstallBlocked(engines)}`

  if (!state.selectedEngine) {
    return `
      ${enginePicker}
      ${installing ? `
        <div class="tool-action-panel">
          <header><strong>${t('Installing')} ${escapeHTML(installing.name)}</strong></header>
          <pre class="tool-action-output">${escapeHTML(installing.output || t('(no output yet)'))}</pre>
          <p class="resource-detail ${installing.running ? '' : installing.error || installing.exitCode !== 0 ? 'tool-action-failed' : 'tool-action-ok'}">
            ${installing.running ? t('Running…') : installing.error ? `${t('Failed:')} ${escapeHTML(installing.error)}` : installing.exitCode === 0 ? t('Done.') : `${t('Exited with code')} ${installing.exitCode}.`}
          </p>
        </div>` : ''}
      <div class="server-vpn-actions">
        <button class="btn-secondary" data-server-vpn-edit-cancel="${escapeHTML(serverId)}" ${busy ? 'disabled' : ''}>${t('Cancel')}</button>
      </div>`
  }

  const engine = engines.find(e => e.kind === state.selectedEngine)
  if (!engine) return ''
  // A select field with no options can't be filled in — for the System VPN
  // engine that means no VPN is configured in macOS yet (or reading the
  // list failed: options_error), so replace the form with the explanation
  // and a button opening the system's own VPN settings (the only place
  // such a VPN can be created).
  const emptySelect = engine.fields.find(f => f.type === 'select' && !(f.options || []).length)
  if (emptySelect) {
    return `
      ${enginePicker}
      ${emptySelect.options_error
        ? `<p class="resource-detail tool-action-failed">${escapeHTML(t(emptySelect.options_error))}</p>`
        : `<p class="resource-detail muted">${t('No VPN configurations found in macOS System Settings. Create one there first (e.g. L2TP/IPsec or IKEv2), including its password, then reopen this panel.')}</p>`}
      <div class="server-vpn-actions">
        <button class="btn-secondary" data-open-vpn-settings>${t('Open VPN Settings…')}</button>
        <button class="btn-secondary" data-server-vpn-edit-cancel="${escapeHTML(serverId)}" ${busy ? 'disabled' : ''}>${t('Cancel')}</button>
      </div>`
  }
  return `
    ${enginePicker}
    <div class="server-add-grid">
      ${engine.fields.map(f => `
        <label class="server-add-field server-add-field-${f.span}">
          <span>${t(f.label)}${f.required ? ' *' : ''}</span>
          ${f.type === 'select'
            ? `<select class="search-input" data-server-vpn-field="${escapeHTML(serverId)}" data-vpn-field-key="${f.key}" ${busy ? 'disabled' : ''}>
                ${(f.options || []).map(o => `<option value="${escapeHTML(o.value)}">${escapeHTML(o.label)}</option>`).join('')}
              </select>`
            : f.multiline
              ? `<textarea class="server-vpn-textarea" data-server-vpn-field="${escapeHTML(serverId)}" data-vpn-field-key="${f.key}" placeholder="${escapeHTML(t(f.placeholder || ''))}" ${busy ? 'disabled' : ''}></textarea>`
              : `<input class="search-input" type="${f.secret ? 'password' : 'text'}" data-server-vpn-field="${escapeHTML(serverId)}" data-vpn-field-key="${f.key}" placeholder="${escapeHTML(t(f.placeholder || ''))}" autocomplete="off" ${busy ? 'disabled' : ''}>`}
        </label>`).join('')}
    </div>
    <div class="server-vpn-actions">
      <button class="btn-secondary" data-server-vpn-save="${escapeHTML(serverId)}" data-vpn-engine="${escapeHTML(engine.kind)}" ${busy ? 'disabled' : ''}>${state.busy === 'saving' ? t('Saving…') : t('Save config')}</button>
      <button class="btn-secondary" data-server-vpn-edit-cancel="${escapeHTML(serverId)}" ${busy ? 'disabled' : ''}>${t('Cancel')}</button>
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
