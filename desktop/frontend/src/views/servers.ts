// Remote Servers: SSH-based management of servers you've configured by
// hand (host/user/port/key path — never the key's contents). CheckServer
// is read-only (uptime/memory/disk/docker status), parsed into structured
// fields on a best-effort basis (see desktop/servers.go). The terminal is a
// real interactive PTY-backed SSH session (see ../serverTerminal.ts) —
// like the terminal session you'd otherwise open by hand for this box, it
// is intentionally not gated behind a confirm-per-keystroke/command
// dialog. Container start/stop/restart on a remote server DO ask for
// confirmation first, the same as their local Docker equivalents.
import type { ServerConnection, ServerHealth, RemoteContainer } from '../api'
import type { ServerTerminalStatus } from '../serverTerminal'
import { escapeHTML } from '../dom'

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

export interface ServersViewState {
  servers: ServerConnection[]
  checks: Map<string, ServerHealth | 'checking'>
  keyWarnings: Map<string, string>
  terminal: ServerTerminalState | null
  containers: Map<string, ServerContainersState>
  showAddForm: boolean
}

const ENVIRONMENTS = ['production', 'staging', 'dev']

export function renderServersView(state: ServersViewState): void {
  const container = document.getElementById('servers-content')
  if (!container) return

  container.innerHTML = `
    <div class="servers-toolbar">
      <button class="btn-secondary" data-server-add-toggle>${state.showAddForm ? 'Cancel' : 'Add server'}</button>
    </div>

    ${state.showAddForm ? renderAddForm() : ''}

    ${state.servers.length ? '' : '<div class="empty compact">No servers configured yet. Add one with its host, SSH user, and .pem key path.</div>'}

    <div class="resource-list servers-list">
      ${state.servers.map(s => renderServerRow(s, state)).join('')}
    </div>
  `
}

function renderAddForm(): string {
  return `
    <div class="server-add-form">
      <p class="server-add-notice">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Only the key file's path is saved — Thaloca never reads or copies its contents. SSH itself reads the key directly from disk when connecting. The first connection to a new host auto-trusts its key (still fails later if that key ever changes).
      </p>
      <div class="server-add-grid">
        <label class="server-add-field">
          <span>Name</span>
          <input class="search-input" data-field="name" placeholder="Optional, defaults to host">
        </label>
        <label class="server-add-field">
          <span>Host</span>
          <input class="search-input" data-field="host" placeholder="1.2.3.4 or my.server.com">
        </label>
        <label class="server-add-field server-add-field-narrow">
          <span>Port</span>
          <input class="search-input" data-field="port" placeholder="22" type="number">
        </label>
        <label class="server-add-field">
          <span>SSH user</span>
          <input class="search-input" data-field="user" placeholder="e.g. ubuntu">
        </label>
        <label class="server-add-field server-add-field-narrow">
          <span>Environment</span>
          <select class="search-input" data-field="environment">
            <option value="">None</option>
            ${ENVIRONMENTS.map(e => `<option value="${e}">${e[0].toUpperCase()}${e.slice(1)}</option>`).join('')}
          </select>
        </label>
        <label class="server-add-field server-add-field-wide">
          <span>Private key file</span>
          <div class="server-add-key-row">
            <input class="search-input" data-field="keyPath" placeholder="/path/to/key.pem" readonly>
            <button class="btn-secondary" data-server-browse-key>Browse…</button>
          </div>
        </label>
      </div>
      <div class="server-add-buttons">
        <button class="btn-primary" data-server-add-submit>Save server</button>
      </div>
    </div>`
}

function renderServerRow(s: ServerConnection, state: ServersViewState): string {
  const check = state.checks.get(s.id)
  const terminalOpen = state.terminal?.serverId === s.id
  const containers = state.containers.get(s.id)
  const keyWarning = state.keyWarnings.get(s.id)
  return `
    <div class="server-row">
      <div class="server-row-header">
        <div>
          <strong>${escapeHTML(s.name)}</strong>
          ${s.environment ? `<span class="env-badge env-badge-${escapeHTML(s.environment)}">${escapeHTML(s.environment)}</span>` : ''}
          <span class="resource-detail muted">${escapeHTML(s.user)}@${escapeHTML(s.host)}:${s.port}</span>
        </div>
        <div class="server-row-actions">
          <button class="btn-secondary" data-server-check="${escapeHTML(s.id)}" ${check === 'checking' ? 'disabled' : ''}>${check === 'checking' ? 'Checking…' : 'Check'}</button>
          <button class="btn-secondary" data-server-containers-toggle="${escapeHTML(s.id)}">${containers ? 'Hide containers' : 'Containers'}</button>
          <button class="btn-secondary" data-server-terminal-toggle="${escapeHTML(s.id)}">${terminalOpen ? 'Close terminal' : 'Terminal'}</button>
          <button class="btn-secondary" data-server-remove="${escapeHTML(s.id)}">Remove</button>
        </div>
      </div>
      ${keyWarning ? `
        <div class="server-key-warning">
          <span class="resource-detail tool-action-failed">${escapeHTML(keyWarning)}</span>
          <button class="btn-secondary" data-server-fix-key="${escapeHTML(s.id)}">Fix permissions</button>
        </div>` : ''}
      ${check && check !== 'checking' ? renderHealthCard(check) : ''}
      ${containers ? renderContainersPanel(s.id, containers) : ''}
      ${terminalOpen && state.terminal ? renderTerminalPanel(state.terminal) : ''}
    </div>`
}

function renderHealthCard(health: ServerHealth): string {
  if (!health.reachable) {
    return `
      <div class="server-health">
        <p class="resource-detail tool-action-failed">Unreachable${health.error ? ': ' + escapeHTML(health.error) : ''}</p>
        ${health.raw ? `<pre class="tool-action-output server-check-output">${escapeHTML(health.raw)}</pre>` : ''}
      </div>`
  }
  return `
    <div class="server-health">
      <div class="server-health-grid">
        <div class="server-health-stat"><span class="resource-detail muted">Uptime</span><strong>${escapeHTML(health.uptime || '—')}</strong></div>
        <div class="server-health-stat"><span class="resource-detail muted">Memory</span><strong>${escapeHTML(health.memory || '—')}</strong></div>
        <div class="server-health-stat"><span class="resource-detail muted">Disk</span><strong class="${health.disk_percent >= 90 ? 'tool-action-failed' : ''}">${escapeHTML(health.disk || '—')}</strong></div>
        <div class="server-health-stat"><span class="resource-detail muted">Docker</span><strong>${health.docker_available ? `${health.containers.length} container${health.containers.length === 1 ? '' : 's'}` : 'not available'}</strong></div>
      </div>
      ${health.docker_available && health.containers.length ? `
        <div class="server-health-containers">
          ${health.containers.map(c => `
            <div class="server-health-container-row">
              <span>${escapeHTML(c.name)}</span>
              <span class="resource-detail muted">${escapeHTML(c.status)}</span>
            </div>`).join('')}
        </div>` : ''}
    </div>`
}

function renderContainersPanel(serverId: string, state: ServerContainersState): string {
  if (state.status === 'loading') {
    return `<div class="server-containers"><div class="empty compact">Loading containers…</div></div>`
  }
  if (state.status === 'error') {
    return `<div class="server-containers"><p class="resource-detail tool-action-failed">${escapeHTML(state.error || 'Failed to load containers.')}</p></div>`
  }
  if (!state.items.length) {
    return `<div class="server-containers"><div class="empty compact">No containers found on this server.</div></div>`
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
              ? `<button class="btn-secondary" data-server-container-stop="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">Stop</button>
                 <button class="btn-secondary" data-server-container-restart="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">Restart</button>`
              : `<button class="btn-secondary" data-server-container-start="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">Start</button>`}
            <button class="btn-secondary" data-server-container-logs="${escapeHTML(serverId)}" data-container-id="${escapeHTML(c.id)}">Logs</button>
          </div>
        </div>
        ${state.logs?.containerId === c.id ? `<pre class="tool-action-output">${escapeHTML(state.logs.text || '(no output)')}</pre>` : ''}
      `).join('')}
    </div>`
}

function renderTerminalPanel(state: ServerTerminalState): string {
  const statusLabel = state.status === 'connecting' ? 'Connecting…' : state.status === 'open' ? 'Connected' : 'Closed'
  return `
    <div class="server-terminal">
      <div class="server-terminal-toolbar">
        <span class="resource-detail server-terminal-status server-terminal-status-${state.status}">${statusLabel}</span>
        ${state.detail ? `<span class="resource-detail tool-action-failed">${escapeHTML(state.detail)}</span>` : ''}
      </div>
      <div class="server-terminal-surface" data-server-terminal-mount="${escapeHTML(state.serverId)}"></div>
    </div>`
}
