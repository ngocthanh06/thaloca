// Volumes / Networks / Images sub-tabs inside Runtime: list Docker
// resources and remove them one at a time. Lazily loaded on first visit,
// same idiom as configFiles.ts/envFiles.ts, rather than tied into the 30s
// Snapshot poll that drives the Containers/Processes/Ports/Jobs sub-tabs.
import type { DockerVolume, DockerNetwork, DockerImage } from '../api'
import { api } from '../api'
import { escapeHTML, showError } from '../dom'
import { t } from '../i18n'

// Volumes/images can legitimately share a name/ID across two distinct
// Docker daemons (a generic volume name like "data", or an image ID —
// content-addressed, so identical pulled images always match) — so
// "removing" state and post-remove list filtering must key on identity
// *and* engine together, never identity alone, or acting on one daemon's
// copy would also disable/hide the other daemon's untouched one.
function resourceKey(identity: string, engine: string): string {
  return `${identity}::${engine}`
}

// Groups rows under an "In use"/"Unused" heading (see the config-section
// classes configFiles.ts already established for this shape) instead of a
// per-row badge, so the two states are visually separated rather than
// interleaved in one long list.
function renderGroup(title: string, rows: string[]): string {
  if (rows.length === 0) return ''
  return `
    <div class="config-section">
      <div class="config-section-title">${escapeHTML(title)} (${rows.length})</div>
      <div class="config-section-rows">${rows.join('')}</div>
    </div>`
}

let volumes: DockerVolume[] | null = null
let volumesLoading = false
let removingVolume = ''

let networks: DockerNetwork[] | null = null
let networksLoading = false
let removingNetwork = ''

let images: DockerImage[] | null = null
let imagesLoading = false
let removingImage = ''

export function initVolumesView(): void {
  if (volumes !== null) {
    renderVolumesView()
    return
  }
  void loadVolumes()
}

export async function loadVolumes(): Promise<void> {
  volumesLoading = true
  renderVolumesView()
  try {
    volumes = (await api.listVolumes()) || []
  } catch (error) {
    showError(String(error))
    volumes = []
  }
  volumesLoading = false
  renderVolumesView()
}

async function removeVolume(name: string, engine: string): Promise<void> {
  const key = resourceKey(name, engine)
  if (removingVolume) return
  if (!(await api.confirmDialog(t('Remove volume'), `${t('Remove volume')} "${name}"? ${t('Any data stored in it will be lost. Docker refuses this if the volume is still in use by a container.')}`))) return
  removingVolume = key
  renderVolumesView()
  try {
    await api.removeVolume(name, engine)
    volumes = (volumes || []).filter(v => resourceKey(v.name, v.engine || '') !== key)
  } catch (error) {
    showError(String(error))
  }
  removingVolume = ''
  renderVolumesView()
}

function renderVolumeRow(v: DockerVolume): string {
  const key = resourceKey(v.name, v.engine || '')
  return `
    <div class="config-row">
      <div class="config-row-main">
        <div class="config-row-title">
          <code class="config-row-name">${escapeHTML(v.name)}</code>
          ${v.engine ? `<span class="engine-badge" title="${t('Docker context')}">${escapeHTML(v.engine)}</span>` : ''}
          ${v.driver ? `<span class="config-badge config-badge-readonly">${escapeHTML(v.driver)}</span>` : ''}
        </div>
        ${v.mountpoint ? `<p class="config-row-value"><code>${escapeHTML(v.mountpoint)}</code></p>` : ''}
      </div>
      <button class="repo-action danger" data-remove-volume="${escapeHTML(v.name)}" data-engine="${escapeHTML(v.engine || '')}" ${removingVolume === key ? 'disabled' : ''}>${removingVolume === key ? t('Removing…') : t('Remove')}</button>
    </div>`
}

export function renderVolumesView(): void {
  const root = document.getElementById('volumes-content')
  if (!root) return
  const list = volumes || []
  root.innerHTML = `
    <div class="env-toolbar">
      <button class="btn-secondary" id="volumes-refresh-btn" ${volumesLoading ? 'disabled' : ''}>${volumesLoading ? t('Scanning…') : t('Refresh')}</button>
    </div>
    ${volumesLoading && volumes === null ? `<div class="empty compact">${t('Scanning for volumes…')}</div>` : ''}
    ${!volumesLoading && list.length === 0 ? `<div class="empty compact">${t('No volumes found.')}</div>` : ''}
    ${renderGroup(t('In use'), list.filter(v => v.in_use).map(renderVolumeRow))}
    ${renderGroup(t('Unused'), list.filter(v => !v.in_use).map(renderVolumeRow))}
  `
  document.getElementById('volumes-refresh-btn')?.addEventListener('click', () => void loadVolumes())
  root.querySelectorAll<HTMLButtonElement>('[data-remove-volume]').forEach(btn => {
    btn.addEventListener('click', () => void removeVolume(btn.dataset.removeVolume || '', btn.dataset.engine || ''))
  })
}

export function initNetworksView(): void {
  if (networks !== null) {
    renderNetworksView()
    return
  }
  void loadNetworks()
}

export async function loadNetworks(): Promise<void> {
  networksLoading = true
  renderNetworksView()
  try {
    networks = (await api.listNetworks()) || []
  } catch (error) {
    showError(String(error))
    networks = []
  }
  networksLoading = false
  renderNetworksView()
}

async function removeNetwork(id: string, name: string, engine: string): Promise<void> {
  const key = resourceKey(id, engine)
  if (removingNetwork) return
  if (!(await api.confirmDialog(t('Remove network'), `${t('Remove network')} "${name}"? ${t('Docker refuses this if a container is still attached to it.')}`))) return
  removingNetwork = key
  renderNetworksView()
  try {
    await api.removeNetwork(id, engine)
    networks = (networks || []).filter(n => resourceKey(n.id, n.engine || '') !== key)
  } catch (error) {
    showError(String(error))
  }
  removingNetwork = ''
  renderNetworksView()
}

function renderNetworkRow(n: DockerNetwork): string {
  const key = resourceKey(n.id, n.engine || '')
  return `
    <div class="config-row">
      <div class="config-row-main">
        <div class="config-row-title">
          <code class="config-row-name">${escapeHTML(n.name)}</code>
          ${n.engine ? `<span class="engine-badge" title="${t('Docker context')}">${escapeHTML(n.engine)}</span>` : ''}
          ${n.driver ? `<span class="config-badge config-badge-readonly">${escapeHTML(n.driver)}</span>` : ''}
          ${n.scope ? `<span class="config-badge config-badge-off">${escapeHTML(n.scope)}</span>` : ''}
        </div>
        <p class="config-row-value"><code>${escapeHTML(n.id)}</code></p>
      </div>
      <button class="repo-action danger" data-remove-network="${escapeHTML(n.id)}" data-network-name="${escapeHTML(n.name)}" data-engine="${escapeHTML(n.engine || '')}" ${removingNetwork === key ? 'disabled' : ''}>${removingNetwork === key ? t('Removing…') : t('Remove')}</button>
    </div>`
}

export function renderNetworksView(): void {
  const root = document.getElementById('networks-content')
  if (!root) return
  const list = networks || []
  root.innerHTML = `
    <div class="env-toolbar">
      <button class="btn-secondary" id="networks-refresh-btn" ${networksLoading ? 'disabled' : ''}>${networksLoading ? t('Scanning…') : t('Refresh')}</button>
    </div>
    ${networksLoading && networks === null ? `<div class="empty compact">${t('Scanning for networks…')}</div>` : ''}
    ${!networksLoading && list.length === 0 ? `<div class="empty compact">${t('No networks found.')}</div>` : ''}
    ${renderGroup(t('In use'), list.filter(n => n.in_use).map(renderNetworkRow))}
    ${renderGroup(t('Unused'), list.filter(n => !n.in_use).map(renderNetworkRow))}
  `
  document.getElementById('networks-refresh-btn')?.addEventListener('click', () => void loadNetworks())
  root.querySelectorAll<HTMLButtonElement>('[data-remove-network]').forEach(btn => {
    btn.addEventListener('click', () => void removeNetwork(btn.dataset.removeNetwork || '', btn.dataset.networkName || '', btn.dataset.engine || ''))
  })
}

export function initImagesView(): void {
  if (images !== null) {
    renderImagesView()
    return
  }
  void loadImages()
}

export async function loadImages(): Promise<void> {
  imagesLoading = true
  renderImagesView()
  try {
    images = (await api.listImages()) || []
  } catch (error) {
    showError(String(error))
    images = []
  }
  imagesLoading = false
  renderImagesView()
}

async function removeImage(id: string, label: string, engine: string): Promise<void> {
  const key = resourceKey(id, engine)
  if (removingImage) return
  if (!(await api.confirmDialog(t('Remove image'), `${t('Remove image')} "${label}"? ${t('Docker refuses this if a container still depends on it.')}`))) return
  removingImage = key
  renderImagesView()
  try {
    await api.removeImage(id, engine)
    images = (images || []).filter(i => resourceKey(i.id, i.engine || '') !== key)
  } catch (error) {
    showError(String(error))
  }
  removingImage = ''
  renderImagesView()
}

function renderImageRow(img: DockerImage): string {
  const key = resourceKey(img.id, img.engine || '')
  const label = img.repository && img.repository !== '<none>' ? `${img.repository}:${img.tag}` : img.id
  return `
    <div class="config-row">
      <div class="config-row-main">
        <div class="config-row-title">
          <code class="config-row-name">${escapeHTML(label)}</code>
          ${img.engine ? `<span class="engine-badge" title="${t('Docker context')}">${escapeHTML(img.engine)}</span>` : ''}
          ${img.size ? `<span class="config-badge config-badge-readonly">${escapeHTML(img.size)}</span>` : ''}
        </div>
        <p class="config-row-value"><code>${escapeHTML(img.id)}</code>${img.created ? ` · ${escapeHTML(img.created)}` : ''}</p>
      </div>
      <button class="repo-action danger" data-remove-image="${escapeHTML(img.id)}" data-image-label="${escapeHTML(label)}" data-engine="${escapeHTML(img.engine || '')}" ${removingImage === key ? 'disabled' : ''}>${removingImage === key ? t('Removing…') : t('Remove')}</button>
    </div>`
}

export function renderImagesView(): void {
  const root = document.getElementById('images-content')
  if (!root) return
  const list = images || []
  root.innerHTML = `
    <div class="env-toolbar">
      <button class="btn-secondary" id="images-refresh-btn" ${imagesLoading ? 'disabled' : ''}>${imagesLoading ? t('Scanning…') : t('Refresh')}</button>
    </div>
    ${imagesLoading && images === null ? `<div class="empty compact">${t('Scanning for images…')}</div>` : ''}
    ${!imagesLoading && list.length === 0 ? `<div class="empty compact">${t('No images found.')}</div>` : ''}
    ${renderGroup(t('In use'), list.filter(img => img.in_use).map(renderImageRow))}
    ${renderGroup(t('Unused'), list.filter(img => !img.in_use).map(renderImageRow))}
  `
  document.getElementById('images-refresh-btn')?.addEventListener('click', () => void loadImages())
  root.querySelectorAll<HTMLButtonElement>('[data-remove-image]').forEach(btn => {
    btn.addEventListener('click', () => void removeImage(btn.dataset.removeImage || '', btn.dataset.imageLabel || '', btn.dataset.engine || ''))
  })
}
