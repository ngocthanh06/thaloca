// Settings overlay: notification preferences (which events, quiet hours)
// and config backup/export-import. Opened via the gear icon in the header.
import { api } from '../api'
import { showError } from '../dom'
import { getPinnedRepos, setPinnedRepos } from '../views/sourceControl'

let current = {
  enabled: true,
  container_stopped: true,
  health_failed: true,
  job_errored: true,
  server_disconnected: true,
  quiet_hours_start: '',
  quiet_hours_end: '',
}

export function initSettingsPanel(): void {
  if (document.getElementById('settings-root')) return
  const root = document.createElement('div')
  root.id = 'settings-root'
  root.className = 'settings-overlay'
  document.body.appendChild(root)

  root.addEventListener('mousedown', event => {
    if (event.target === root) closeSettingsPanel()
  })
}

export async function openSettingsPanel(): Promise<void> {
  initSettingsPanel()
  current = { ...current, ...(await api.getNotificationSettings()) }
  render()
  document.getElementById('settings-root')?.classList.add('open')
}

export function closeSettingsPanel(): void {
  document.getElementById('settings-root')?.classList.remove('open')
}

function render(): void {
  const root = document.getElementById('settings-root')
  if (!root) return
  root.innerHTML = `
    <div class="settings-box">
      <header>
        <h2>Settings</h2>
        <button class="btn-secondary" data-settings-close>Close</button>
      </header>
      <section class="settings-section">
        <h3>Notifications</h3>
        <p class="resource-detail muted">Native macOS notifications for container/job problems, failed health checks, and disconnected servers.</p>
        <label class="settings-checkbox"><input type="checkbox" data-setting="enabled" ${current.enabled ? 'checked' : ''}> Enable notifications</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="container_stopped" ${current.container_stopped ? 'checked' : ''}> Container stopped / restarting repeatedly</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="health_failed" ${current.health_failed ? 'checked' : ''}> Health check failed</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="job_errored" ${current.job_errored ? 'checked' : ''}> Job errored</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="server_disconnected" ${current.server_disconnected ? 'checked' : ''}> Server disconnected</label>
        <div class="settings-quiet-hours">
          <label>Quiet hours start <input type="time" class="search-input" data-setting="quiet_hours_start" value="${current.quiet_hours_start || ''}"></label>
          <label>Quiet hours end <input type="time" class="search-input" data-setting="quiet_hours_end" value="${current.quiet_hours_end || ''}"></label>
        </div>
      </section>
      <section class="settings-section">
        <h3>Backup</h3>
        <p class="resource-detail muted">Export or import servers, ignored/pinned repos, and notification settings — useful when moving to a new machine. Server entries only ever contain a key file path, never the key's contents.</p>
        <div class="settings-buttons">
          <button class="btn-secondary" data-settings-export>Export config…</button>
          <button class="btn-secondary" data-settings-import>Import config…</button>
        </div>
      </section>
    </div>`

  root.querySelector('[data-settings-close]')?.addEventListener('click', closeSettingsPanel)
  root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input => {
    input.addEventListener('change', () => handleSettingChange(input))
  })
  root.querySelector('[data-settings-export]')?.addEventListener('click', () => void handleExport())
  root.querySelector('[data-settings-import]')?.addEventListener('click', () => void handleImport())
}

async function handleSettingChange(input: HTMLInputElement): Promise<void> {
  const key = input.dataset.setting as keyof typeof current
  if (!key) return
  if (input.type === 'checkbox') {
    (current as any)[key] = input.checked
  } else {
    (current as any)[key] = input.value
  }
  try {
    await api.setNotificationSettings(current)
  } catch (error) {
    showError(`Could not save settings: ${String(error)}`)
  }
}

async function handleExport(): Promise<void> {
  try {
    const path = await api.exportConfig(getPinnedRepos())
    if (path) void api.notify('Config exported', path)
  } catch (error) {
    showError(`Could not export config: ${String(error)}`)
  }
}

async function handleImport(): Promise<void> {
  try {
    const backup = await api.importConfig()
    if (!backup || !backup.exported_at) return // cancelled
    if (backup.pinned_repos) setPinnedRepos(backup.pinned_repos)
    current = { ...current, ...backup.notification_settings }
    render()
    void api.notify('Config imported', 'Reopen Servers / Source Control to see the restored data.')
  } catch (error) {
    showError(`Could not import config: ${String(error)}`)
  }
}
