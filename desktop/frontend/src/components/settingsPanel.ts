// Settings overlay: notification preferences (which events, quiet hours),
// config backup/export-import, and update checking. Opened via the gear
// icon in the header.
import { api, type UpdateInfo } from '../api'
import { escapeHTML, showError } from '../dom'
import { getPinnedRepos, setPinnedRepos } from '../views/sourceControl'
import { SHORTCUT_TARGETS, getShortcuts, setShortcut, setShortcuts, comboFromEvent, formatCombo } from '../keyboardShortcuts'
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
let autoUpdateEnabled = false
// Which shortcut field is currently listening for a key combo, if any —
// see renderShortcutRow/bindShortcutRows below.
let recordingShortcutId: string | null = null

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
  const [settings, version, clipboardEnabled, autoUpdate] = await Promise.all([
    api.getNotificationSettings(), api.getAppVersion(), api.getClipboardHistoryEnabled(), api.getAutoUpdateEnabled(),
  ])
  current = { ...current, ...settings }
  appVersion = version
  clipboardHistoryEnabled = clipboardEnabled
  autoUpdateEnabled = autoUpdate
  render()
  document.getElementById('settings-root')?.classList.add('open')
  // Check for updates the moment Settings opens, so "Update now" is already
  // there if one is available instead of making the user press "Check for
  // updates" first.
  void handleCheckForUpdate()
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
        <h3>${t('Keyboard shortcuts')}</h3>
        <p class="resource-detail muted">${t('Click a field and press a key combination to jump straight to that tab.')}</p>
        <div class="settings-shortcuts">
          ${SHORTCUT_TARGETS.map(target => renderShortcutFieldRow(target.id, target.label, getShortcuts()[target.id])).join('')}
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
        <p class="resource-detail muted">${t("Export or import servers, ignored/pinned repos, keyboard shortcuts, and notification settings — useful when moving to a new machine. Server entries only ever contain a key file path, never the key's contents.")}</p>
        <div class="settings-buttons">
          <button class="btn-secondary" data-settings-export>${t('Export config…')}</button>
          <button class="btn-secondary" data-settings-import>${t('Import config…')}</button>
        </div>
      </section>
      <section class="settings-section">
        <h3>${t('Updates')}</h3>
        <p class="resource-detail muted">${t('Version')} ${appVersion ? escapeHTML(appVersion) : '—'}. ${t('"Update now" checks GitHub\'s SHA-256 and the app bundle before installing and restarting. This build is not Developer ID signed or notarized.')}</p>
        <label class="settings-checkbox"><input type="checkbox" data-setting-auto-update ${autoUpdateEnabled ? 'checked' : ''}> ${t('Automatically install updates when found (quits and restarts Thaloca without asking)')}</label>
        <div class="settings-buttons">
          <button class="btn-secondary" data-settings-check-update ${checkingForUpdate ? 'disabled' : ''}>${checkingForUpdate ? t('Checking…') : t('Check for updates')}</button>
        </div>
        ${renderUpdateResult()}
      </section>
    </div>`

  root.querySelector('[data-settings-close]')?.addEventListener('click', closeSettingsPanel)
  bindShortcutRows(root)
  root.querySelectorAll<HTMLInputElement>('[data-setting]').forEach(input => {
    input.addEventListener('change', () => handleSettingChange(input))
  })
  root.querySelector<HTMLInputElement>('[data-setting-clipboard-history]')?.addEventListener('change', event => {
    void handleClipboardHistoryToggle((event.target as HTMLInputElement).checked)
  })
  root.querySelector<HTMLInputElement>('[data-setting-auto-update]')?.addEventListener('change', event => {
    void handleAutoUpdateToggle((event.target as HTMLInputElement).checked)
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

function renderShortcutFieldRow(id: string, label: string, combo: string | undefined): string {
  const recording = recordingShortcutId === id
  return `
    <div class="settings-shortcut-row">
      <span>${escapeHTML(t(label))}</span>
      <button type="button" class="shortcut-field${recording ? ' recording' : ''}" data-shortcut-field="${id}">${recording ? t('Press keys…') : (combo ? escapeHTML(formatCombo(combo)) : t('Click to set'))}</button>
      <button type="button" class="shortcut-clear" data-shortcut-clear="${id}" title="${t('Clear')}" ${combo ? '' : 'disabled'}>×</button>
    </div>`
}

// The field itself is a plain button (not a text input) so a pressed key
// never types into it — clicking starts "recording", and the very next
// keydown on that button is read as the combo to bind (Escape cancels).
// Every row shares this same recording flow and persists to localStorage.
function bindShortcutRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-shortcut-field]').forEach(field => {
    const id = field.dataset.shortcutField!
    field.addEventListener('click', () => {
      recordingShortcutId = id
      render()
      root.querySelector<HTMLButtonElement>(`[data-shortcut-field="${id}"]`)?.focus()
    })
    field.addEventListener('keydown', event => {
      if (recordingShortcutId !== id) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') { recordingShortcutId = null; render(); return }
      const combo = comboFromEvent(event)
      if (!combo) return
      recordingShortcutId = null
      setShortcut(id, combo)
      render()
    })
    field.addEventListener('blur', () => {
      if (recordingShortcutId === id) { recordingShortcutId = null; render() }
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-shortcut-clear]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.shortcutClear!
      setShortcut(id, null)
      render()
    })
  })
}

function renderUpdateResult(): string {
  if (selfUpdateError) {
    return `<p class="resource-detail tool-action-failed">${t('Could not update:')} ${escapeHTML(selfUpdateError)}</p>`
  }
  if (!updateCheck) return ''
  if (updateCheck.error) {
    return `<p class="resource-detail tool-action-failed">${t('Could not check for updates:')} ${escapeHTML(updateCheck.error)}</p>`
  }
  if (updateCheck.available) {
    return `<p class="resource-detail">Thaloca ${escapeHTML(updateCheck.latest_version || '')} ${t('is available.')}
      <button class="btn-secondary" data-settings-open-release>${t('Open release page')}</button>
      <button class="btn-primary" data-settings-self-update ${selfUpdating ? 'disabled' : ''}>${selfUpdating ? t('Updating…') : t('Update now')}</button>
    </p>`
  }
  return `<p class="resource-detail muted">${t("You're on the latest version.")}</p>`
}

async function handleSelfUpdate(): Promise<void> {
  if (selfUpdating || !updateCheck?.available) return
  const version = updateCheck.latest_version || ''
  if (!(await api.confirmDialog(
    t('Update Thaloca'),
    `${t('Download and install')} Thaloca ${version}? ${t('The update will be verified first; then Thaloca will quit, replace the app, and reopen automatically.')}`,
  ))) return
  selfUpdating = true
  selfUpdateError = ''
  render()
  try {
    await api.performSelfUpdate(version)
  } catch (error) {
    selfUpdateError = String(error)
    selfUpdating = false
    render()
  }
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

async function handleClipboardHistoryToggle(enabled: boolean): Promise<void> {
  clipboardHistoryEnabled = enabled
  try {
    await api.setClipboardHistoryEnabled(enabled)
  } catch (error) {
    clipboardHistoryEnabled = !enabled
    render()
    showError(`${t('Could not save setting:')} ${String(error)}`)
  }
}

async function handleAutoUpdateToggle(enabled: boolean): Promise<void> {
  autoUpdateEnabled = enabled
  try {
    await api.setAutoUpdateEnabled(enabled)
  } catch (error) {
    autoUpdateEnabled = !enabled
    render()
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
    const path = await api.exportConfig(getPinnedRepos(), getShortcuts())
    if (path) void api.notify(t('Config exported'), path)
  } catch (error) {
    showError(`${t('Could not export config:')} ${String(error)}`)
  }
}

async function handleImport(): Promise<void> {
  if (!(await api.confirmDialog(t('Import config'), t("This replaces your current saved servers, ignored/pinned repos, keyboard shortcuts, and notification settings with what's in the chosen file. Continue?")))) return
  try {
    const backup = await api.importConfig()
    if (!backup || !backup.exported_at) return // cancelled
    if (backup.pinned_repos) setPinnedRepos(backup.pinned_repos)
    if (backup.keyboard_shortcuts) setShortcuts(backup.keyboard_shortcuts)
    current = { ...current, ...backup.notification_settings }
    render()
    void api.notify(t('Config imported'), t('Reopen Servers / Source Control to see the restored data.'))
  } catch (error) {
    showError(`${t('Could not import config:')} ${String(error)}`)
  }
}
