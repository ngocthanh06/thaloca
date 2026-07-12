// Port conflict assistant: when a container fails to start/restart because
// Docker reports its port is already taken by something else, this looks
// up who currently holds that port (from data Runtime/Resources already
// loaded) and offers to stop it or copy the command to do so by hand.
import type { PortUsage } from '../api'
import { api } from '../api'
import { copyToClipboard } from '../clipboard'
import { escapeHTML } from '../dom'

// Matches Docker's various "port already taken" error phrasings, e.g.
// "Bind for 0.0.0.0:8080 failed: port is already allocated" or
// "listen tcp 0.0.0.0:8080: bind: address already in use".
export function parsePortConflict(message: string): number | null {
  if (!/port is already allocated|address already in use|ports are not available/i.test(message)) return null
  const matches = [...message.matchAll(/:(\d{2,5})\b/g)]
  if (!matches.length) return null
  const port = Number(matches[matches.length - 1][1])
  return Number.isFinite(port) && port > 0 ? port : null
}

export function showPortConflictAssistant(port: number, owner: PortUsage, onResolved: () => void): void {
  let root = document.getElementById('port-conflict-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'port-conflict-root'
    root.className = 'settings-overlay'
    document.body.appendChild(root)
    root.addEventListener('mousedown', event => {
      if (event.target === root) close()
    })
  }

  const ownerLabel = owner.name || owner.process || (owner.pid ? `PID ${owner.pid}` : 'unknown process')
  const killCommand = owner.container_id ? `docker stop ${owner.container_id}` : `kill ${owner.pid}`
  const close = () => root!.classList.remove('open')

  root.innerHTML = `
    <div class="settings-box">
      <header>
        <h2>Port ${port} is already in use</h2>
        <button class="btn-secondary" data-port-conflict-close>Close</button>
      </header>
      <p class="resource-detail">Port ${port} is currently held by <strong>${escapeHTML(ownerLabel)}</strong>${owner.project ? ` (project ${escapeHTML(owner.project)})` : ''}.</p>
      <div class="settings-buttons">
        <button class="repo-action danger" data-port-conflict-stop>Stop it</button>
        <button class="btn-secondary" data-port-conflict-copy>Copy command</button>
      </div>
    </div>`

  root.querySelector('[data-port-conflict-close]')?.addEventListener('click', close)
  root.querySelector('[data-port-conflict-copy]')?.addEventListener('click', () => {
    void copyToClipboard(killCommand, 'Port conflict assistant')
  })
  root.querySelector('[data-port-conflict-stop]')?.addEventListener('click', () => {
    void (async () => {
      try {
        if (owner.container_id) await api.stopContainer(owner.container_id)
        else if (owner.pid) await api.stopProcess(owner.pid)
      } finally {
        close()
        onResolved()
      }
    })()
  })

  root.classList.add('open')
}
