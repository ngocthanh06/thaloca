// Tools & Packages Manager. Detection (versions, missing-per-project) is
// read-only; Install/Update actually runs a command (see toolActions.go),
// so those always go through a native confirm dialog first and show their
// live output in the panel below the grid while they run.
import type { ToolsSnapshot, ToolInfo, ProjectToolRequirement, ToolActionStatus } from '../api'
import { escapeHTML, formatDate } from '../dom'

export interface ToolActionState {
  tool: string
  name: string
  action: 'install' | 'update'
  command: string
  status: ToolActionStatus
}

export function renderToolsView(snapshot: ToolsSnapshot | null, activeAction: ToolActionState | null = null): void {
  const container = document.getElementById('tools-content')
  if (!container) return

  if (!snapshot || !snapshot.sampled_at) {
    container.innerHTML = `<div class="empty">Checking installed tools…</div>`
    return
  }

  container.innerHTML = `
    ${activeAction ? renderActionPanel(activeAction) : ''}

    <p class="resource-detail muted">Last checked: ${escapeHTML(formatDate(snapshot.sampled_at))}</p>

    <div class="tool-grid">
      ${snapshot.tools.map(renderToolCard).join('')}
    </div>

    <h3 class="section-title">Projects missing a tool</h3>
    <div class="resource-list">
      ${snapshot.projects.length ? snapshot.projects.map(renderProjectGapRow).join('') : '<div class="empty compact">Every detected project has the tools its manifest asks for.</div>'}
    </div>
  `
}

function renderToolCard(tool: ToolInfo): string {
  const action = !tool.installed && tool.install_command
    ? `<button class="btn-secondary" data-tool-install="${escapeHTML(tool.command)}" data-tool-name="${escapeHTML(tool.name)}" data-tool-command="${escapeHTML(tool.install_command)}">Install</button>`
    : tool.installed && tool.update_command
      ? `<button class="btn-secondary" data-tool-update="${escapeHTML(tool.command)}" data-tool-name="${escapeHTML(tool.name)}" data-tool-command="${escapeHTML(tool.update_command)}">Update</button>`
      : ''
  return `
    <article class="tool-card ${tool.installed ? 'installed' : 'missing'}">
      <header>
        <strong>${escapeHTML(tool.name)}</strong>
        <span class="tool-status ${tool.installed ? 'installed' : 'missing'}">${tool.installed ? 'Installed' : 'Not installed'}</span>
      </header>
      <p class="resource-detail">${tool.installed ? escapeHTML(tool.version || tool.command) : `Not found on PATH (${escapeHTML(tool.command)})`}</p>
      ${tool.installed && tool.path ? `<p class="resource-detail muted" title="${escapeHTML(tool.path)}">${escapeHTML(tool.path)}</p>` : ''}
      ${tool.managed_by ? `<p class="resource-detail muted">Managed by ${escapeHTML(tool.managed_by)} — Install/Update not offered here to avoid a conflicting Homebrew copy.</p>` : ''}
      ${action ? `<div class="tool-card-actions">${action}</div>` : ''}
    </article>`
}

function renderProjectGapRow(p: ProjectToolRequirement): string {
  return `
    <div class="resource-row">
      <span class="resource-row-label" title="${escapeHTML(p.path)}">${escapeHTML(p.project)}</span>
      <span class="resource-row-detail">missing: ${p.missing.map(escapeHTML).join(', ')}</span>
      <span class="resource-row-detail muted">requires: ${p.required.map(escapeHTML).join(', ')}</span>
    </div>`
}

function renderActionPanel(state: ToolActionState): string {
  const { status } = state
  const label = state.action === 'install' ? 'Installing' : 'Updating'
  const statusText = status.running
    ? 'Running…'
    : status.error
      ? `Failed: ${escapeHTML(status.error)}`
      : status.exit_code === 0
        ? 'Done.'
        : `Exited with code ${status.exit_code}.`
  return `
    <div class="tool-action-panel">
      <header>
        <strong>${label} ${escapeHTML(state.name)}</strong>
        <code>${escapeHTML(state.command)}</code>
        ${status.running ? '' : '<button class="btn-secondary" data-tool-action-close>Close</button>'}
      </header>
      <pre class="tool-action-output">${escapeHTML(status.output || '(no output yet)')}</pre>
      <p class="resource-detail ${status.running ? '' : status.error || status.exit_code !== 0 ? 'tool-action-failed' : 'tool-action-ok'}">${statusText}</p>
    </div>`
}
