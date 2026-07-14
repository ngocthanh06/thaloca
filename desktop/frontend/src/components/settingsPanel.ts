// Settings overlay: notification preferences (which events, quiet hours),
// config backup/export-import, and update checking. Opened via the gear
// icon in the header.
import { api, type UpdateInfo } from '../api'
import { showError } from '../dom'
import { getPinnedRepos, setPinnedRepos } from '../views/sourceControl'
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'
import { getLocale, setLocale, t, type Locale } from '../i18n'

let current = {
  enabled: true,
  container_stopped: true,
  health_failed: true,
  job_errored: true,
  server_disconnected: true,
  update_available: true,
  quiet_hours_start: '',
  quiet_hours_end: '',
}

let appVersion = ''
let updateCheck: UpdateInfo | null = null
let checkingForUpdate = false
let selfUpdating = false
let selfUpdateError = ''
let clipboardHistoryEnabled = true

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
  const [settings, version, clipboardEnabled] = await Promise.all([
    api.getNotificationSettings(), api.getAppVersion(), api.getClipboardHistoryEnabled(),
  ])
  current = { ...current, ...settings }
  appVersion = version
  clipboardHistoryEnabled = clipboardEnabled
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
        <h2>${t('Settings')}</h2>
        <button class="btn-secondary" data-settings-close>${t('Close')}</button>
      </header>
      <section class="settings-section">
        <h3>${t('Notifications')}</h3>
        <p class="resource-detail muted">${t('Native macOS notifications for container/job problems, failed health checks, and disconnected servers.')}</p>
        <label class="settings-checkbox"><input type="checkbox" data-setting="enabled" ${current.enabled ? 'checked' : ''}> ${t('Enable notifications')}</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="container_stopped" ${current.container_stopped ? 'checked' : ''}> ${t('Container stopped / restarting repeatedly')}</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="health_failed" ${current.health_failed ? 'checked' : ''}> ${t('Health check failed')}</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="job_errored" ${current.job_errored ? 'checked' : ''}> ${t('Job errored')}</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="server_disconnected" ${current.server_disconnected ? 'checked' : ''}> ${t('Server disconnected')}</label>
        <label class="settings-checkbox"><input type="checkbox" data-setting="update_available" ${current.update_available ? 'checked' : ''}> ${t('Update available')}</label>
        <div class="settings-quiet-hours">
          <label>${t('Quiet hours start')} <input type="time" class="search-input" data-setting="quiet_hours_start" value="${current.quiet_hours_start || ''}"></label>
          <label>${t('Quiet hours end')} <input type="time" class="search-input" data-setting="quiet_hours_end" value="${current.quiet_hours_end || ''}"></label>
        </div>
      </section>
      <section class="settings-section">
        <h3>${t('Language')}</h3>
        <div class="settings-buttons">
          <button class="btn-secondary${getLocale() === 'en' ? ' settings-lang-active' : ''}" data-settings-lang="en">English</button>
          <button class="btn-secondary${getLocale() === 'vi' ? ' settings-lang-active' : ''}" data-settings-lang="vi">Tiếng Việt</button>
        </div>
      </section>
      <section class="settings-section">
        <h3>${t('Privacy')}</h3>
        <p class="resource-detail muted">${t('Clipboard History records anything copied anywhere on the Mac (not just inside Thaloca), including from password managers or terminals, so it can show up in the copy-history panel. Turn this off if you\'d rather it only ever record explicit "Copy" clicks made inside Thaloca itself.')}</p>
        <label class="settings-checkbox"><input type="checkbox" data-setting-clipboard-history ${clipboardHistoryEnabled ? 'checked' : ''}> ${t('Record system-wide clipboard activity')}</label>
      </section>
      <section class="settings-section">
        <h3>${t('Backup')}</h3>
        <p class="resource-detail muted">${t("Export or import servers, ignored/pinned repos, and notification settings — useful when moving to a new machine. Server entries only ever contain a key file path, never the key's contents.")}</p>
        <div class="settings-buttons">
          <button class="btn-secondary" data-settings-export>${t('Export config…')}</button>
          <button class="btn-secondary" data-settings-import>${t('Import config…')}</button>
        </div>
      </section>
      <section class="settings-section">
        <h3>${t('Updates')}</h3>
        <p class="resource-detail muted">${t('Version')} ${appVersion || '—'}. ${t('Checking looks for a newer GitHub release. "Update now" downloads and installs it, then restarts Thaloca — nothing happens without confirming first.')}</p>
        <div class="settings-buttons">
          <button class="btn-secondary" data-settings-check-update ${checkingForUpdate ? 'disabled' : ''}>${checkingForUpdate ? t('Checking…') : t('Check for updates')}</button>
        </div>
        ${renderUpdateResult()}
      </section>
    </div>`

  root.querySelector('[data-settings-close]')?.addEventListener('click', closeSettingsPanel)
  root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input => {
    input.addEventListener('change', () => handleSettingChange(input))
  })
  root.querySelector<HTMLInputElement>('[data-setting-clipboard-history]')?.addEventListener('change', event => {
    void handleClipboardHistoryToggle((event.target as HTMLInputElement).checked)
  })
  root.querySelectorAll<HTMLButtonElement>('[data-settings-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      setLocale(btn.dataset.settingsLang as Locale)
      render()
    })
  })
  root.querySelector('[data-settings-export]')?.addEventListener('click', () => void handleExport())
  root.querySelector('[data-settings-import]')?.addEventListener('click', () => void handleImport())
  root.querySelector('[data-settings-check-update]')?.addEventListener('click', () => void handleCheckForUpdate())
  root.querySelector('[data-settings-open-release]')?.addEventListener('click', () => {
    if (updateCheck?.release_url) BrowserOpenURL(updateCheck.release_url)
  })
  root.querySelector('[data-settings-self-update]')?.addEventListener('click', () => void handleSelfUpdate())
}

function renderUpdateResult(): string {
  if (selfUpdateError) {
    return `<p class="resource-detail tool-action-failed">${t('Could not update:')} ${selfUpdateError}</p>`
  }
  if (!updateCheck) return ''
  if (updateCheck.error) {
    return `<p class="resource-detail tool-action-failed">${t('Could not check for updates:')} ${updateCheck.error}</p>`
  }
  if (updateCheck.available) {
    return `<p class="resource-detail">Thaloca ${updateCheck.latest_version} ${t('is available.')}
      <button class="btn-secondary" data-settings-open-release>${t('Open release page')}</button>
      <button class="btn-primary" data-settings-self-update ${selfUpdating ? 'disabled' : ''}>${selfUpdating ? t('Updating…') : t('Update now')}</button>
    </p>`
  }
  return `<p class="resource-detail muted">${t("You're on the latest version.")}</p>`
}

async function handleCheckForUpdate(): Promise<void> {
  checkingForUpdate = true
  render()
  try {
    updateCheck = await api.checkForUpdate()
  } catch (error) {
    updateCheck = { current_version: appVersion, available: false, error: String(error) }
  }
  checkingForUpdate = false
  render()
}

// Downloads the new build, swaps it in for the currently-installed .app,
// and relaunches — see desktop/selfupdate.go's PerformSelfUpdate for the
// mechanics. On success the app quits before this function would ever
// resolve, so there's nothing to render for that case; on failure nothing
// was touched, so it's safe to just show the error and let the user retry
// or fall back to "Open release page".
async function handleSelfUpdate(): Promise<void> {
  if (selfUpdating) return
  if (!(await api.confirmDialog(
    'Update Thaloca',
    `Download Thaloca ${updateCheck?.latest_version || ''} and install it now? Thaloca will quit and reopen automatically once the update is in place.`,
  ))) return
  selfUpdating = true
  selfUpdateError = ''
  render()
  try {
    await api.performSelfUpdate()
  } catch (error) {
    selfUpdateError = String(error)
    selfUpdating = false
    render()
  }
}

async function handleClipboardHistoryToggle(enabled: boolean): Promise<void> {
  clipboardHistoryEnabled = enabled
  try {
    await api.setClipboardHistoryEnabled(enabled)
  } catch (error) {
    showError(`${t('Could not save setting:')} ${String(error)}`)
  }
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
    showError(`${t('Could not save settings:')} ${String(error)}`)
  }
}

async function handleExport(): Promise<void> {
  try {
    const path = await api.exportConfig(getPinnedRepos())
    if (path) void api.notify(t('Config exported'), path)
  } catch (error) {
    showError(`${t('Could not export config:')} ${String(error)}`)
  }
}

async function handleImport(): Promise<void> {
  if (!(await api.confirmDialog(t('Import config'), t("This replaces your current saved servers, ignored/pinned repos, and notification settings with what's in the chosen file. Continue?")))) return
  try {
    const backup = await api.importConfig()
    if (!backup || !backup.exported_at) return // cancelled
    if (backup.pinned_repos) setPinnedRepos(backup.pinned_repos)
    current = { ...current, ...backup.notification_settings }
    render()
    void api.notify(t('Config imported'), t('Reopen Servers / Source Control to see the restored data.'))
  } catch (error) {
    showError(`${t('Could not import config:')} ${String(error)}`)
  }
}
