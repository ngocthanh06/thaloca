import {
  api, normalizeActivity, normalizeServices, normalizeJobs, normalizePorts,
  type Service, type PortUsage, type HealthStatus,
  type RepositoryActivity, type ActivitySummary,
  type Job, type OverviewResult, type TimelineEvent, type ResourceSnapshot, type ToolsSnapshot,
  type ServerConnection, type ServerHealth, type RemoteContainer, type InstalledApp, type ResourceSample,
} from './api'
import { escapeHTML, formatBytes, formatDuration, formatDate, getStatusClass, getSourceBadgeClass, matchesSearch, showLoading, showError } from './dom'
import { renderOverviewView } from './views/overview'
import { renderResourcesView, type ProcessSort } from './views/resources'
import { wireResourceHistoryHover, type HistoryWindow } from './components/resourceCharts'
import { renderToolsView, type ToolActionState } from './views/tools'
import { renderServersView, type ServerTerminalState, type ServerContainersState } from './views/servers'
import { openServerTerminal, closeServerTerminal, reattachServerTerminal, type ServerTerminalStatus } from './serverTerminal'
import { BrowserOpenURL } from '../wailsjs/runtime/runtime'
import {
  renderServicesView, renderPortsView, renderJobsView, toggleProjectExpanded,
  checkAllHealth as checkAllHealthRuntime,
} from './views/runtime'
import { renderTimelineView, TIMELINE_NAVIGATE_EVENT, type TimelineRow } from './views/timeline'
import {
  renderSourceView, setSourceFilter, openRepoInSourceControl, togglePinRepo,
  loadRepoTab, refreshGHStatus, handleGHAction, handleSyncAction, handleLoadMore,
  handleCommitAction, handleChangesAction, handleDiffViewToggle, handleBranchAction, handleFileAction,
  handlePRAction, handlePRFilterSelectChange, handlePRSearchInput, handleBranchFilterInput,
  initDiffCommentDrag, ACTIVITY_REFRESH_EVENT, type RepoDetail,
} from './views/sourceControl'
import { openServiceInspector, closeServiceInspector, runServiceAction } from './components/serviceInspector'
import { initCommandPalette, setCommandPaletteIndex, type CommandItem } from './components/commandPalette'
import { initSettingsPanel, openSettingsPanel } from './components/settingsPanel'
import { initClipboardHistoryPanel, openClipboardHistoryPanel } from './components/clipboardHistoryPanel'
import { parsePortConflict, showPortConflictAssistant } from './components/portConflictAssistant'

let services: Service[] = []
let ports: PortUsage[] = []
let jobs: Job[] = []
let activity: ActivitySummary | null = null
let overview: OverviewResult | null = null
let resources: ResourceSnapshot | null = null
let tools: ToolsSnapshot | null = null
let servers: ServerConnection[] = []
let serverChecks: Map<string, ServerHealth | 'checking'> = new Map()
let serverKeyWarnings: Map<string, string> = new Map()
let serverContainers: Map<string, ServerContainersState> = new Map()
let serverTerminal: ServerTerminalState | null = null
let showAddServerForm = false
let timelineEvents: TimelineEvent[] = []
let timelineFilter: 'all' | 'runtime' | 'git' | 'health' | 'action' = 'all'
let healthCache: Map<string, HealthStatus> = new Map()
let refreshTimer: number | null = null
let searchQuery = ''
// Activity: which repo card (by path) is expanded inline — showing recent
// commits/events without navigating away to Source Control. Only one open
// at a time (accordion), like Runtime's project groups.
let expandedActivityRepo: string | null = null
const jobLogs = new Map<string, string>()
// project name → combined "docker compose logs" output (unified log panel)
const projectLogs = new Map<string, string>()
// pid (string) → best-effort tailed log file content for a local process
const processLogs = new Map<string, string>()
// container id → starting | stopping | restarting (UI pending state)
const pendingContainers = new Map<string, string>()
// project name → starting | stopping | restarting | removing (UI pending
// state for the "Start all"/"Stop all"/... project header buttons — shown
// even while the project's row list is collapsed, unlike pendingContainers).
const pendingProjects = new Map<string, string>()


function renderApp() {
  const app = document.getElementById('app')!
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="mark">T</div>
          <div>
            <strong>Thaloca</strong>
            <small>Developer Control Center</small>
          </div>
        </div>
        <nav class="nav">
          <button class="nav-btn active" data-view="overview">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
            </svg>
            <span>Overview</span>
          </button>
          <button class="nav-btn" data-view="runtime">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            <span>Runtime</span>
          </button>
          <button class="nav-btn" data-view="source">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h4a2 2 0 0 1 2 2v1"/><path d="M9 18h4a2 2 0 0 0 2-2v-1"/>
            </svg>
            <span>Source Control</span>
          </button>
          <button class="nav-btn" data-view="activity">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>Activity</span>
          </button>
          <button class="nav-btn" data-view="resources">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/>
              <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>
            </svg>
            <span>Resources</span>
          </button>
          <button class="nav-btn" data-view="tools">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <span>Tools</span>
          </button>
          <button class="nav-btn" data-view="servers">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="7" rx="1.5"/><rect x="2" y="14" width="20" height="7" rx="1.5"/>
              <line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/>
            </svg>
            <span>Servers</span>
          </button>
        </nav>
        <div class="local-status">
          <div class="pulse"></div>
          <div>
            <strong>Local Machine</strong>
            <small>Connected</small>
          </div>
        </div>
      </aside>
      <main class="main">
        <header>
          <div>
            <p class="eyebrow">LOCAL ENVIRONMENT</p>
            <h1 id="view-title">Overview</h1>
          </div>
          <div class="header-actions">
            <input id="search-input" class="search-input" type="search" placeholder="Search name, port, project...">
            <button id="clipboard-btn" class="btn-icon" title="Copy history">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              </svg>
            </button>
            <button id="settings-btn" class="btn-icon" title="Settings">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button id="fullscreen-btn" class="btn-icon" title="Toggle fullscreen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>
              </svg>
            </button>
            <button id="refresh-btn" class="primary">Refresh</button>
          </div>
        </header>
        <div id="error-banner" class="error-banner"></div>

        <section id="overview-view" class="view active"></section>

        <section id="runtime-view" class="view">
          <p class="subview-desc" id="runtime-summary">—</p>
          <nav class="subtabs" id="services-subtabs">
            <button class="subtab active" data-subtab="docker">Containers <span class="subtab-count" id="count-docker"></span></button>
            <button class="subtab" data-subtab="processes">Processes <span class="subtab-count" id="count-processes"></span></button>
            <button class="subtab" data-subtab="ports">Ports <span class="subtab-count" id="count-ports"></span></button>
            <button class="subtab" data-subtab="jobs">Jobs <span class="subtab-count" id="count-jobs"></span></button>
          </nav>
          <div id="subview-docker" class="subview active">
            <p class="subview-desc">Containers grouped by Docker Compose project. Click a project to expand it; start or stop one container or the whole project.</p>
            <div id="docker-list"></div>
          </div>
          <div id="subview-processes" class="subview">
            <p class="subview-desc">Programs running directly on this Mac (outside Docker) that are listening on a TCP port — dev servers, tools, system services.</p>
            <div id="process-list"></div>
          </div>
          <div id="subview-ports" class="subview">
            <p class="subview-desc">Every local TCP port currently in use and which process or container owns it.</p>
            <div id="ports-list" class="ports-list"></div>
          </div>
          <div id="subview-jobs" class="subview">
            <p class="subview-desc">Background jobs from Docker workers, cron, launchd, and PM2.</p>
            <div id="jobs-list" class="jobs-list"></div>
          </div>
        </section>

        <section id="source-view" class="view">
          <div class="source-toolbar">
            <p class="subview-desc">Work with your repositories like SourceTree: stage, commit, diff, resolve conflicts, browse history, graph and review pull requests.</p>
            <div id="gh-connect-area"></div>
          </div>
          <div class="source-layout">
            <div class="source-left">
              <input id="source-filter" class="search-input source-filter" type="search" placeholder="Filter repositories...">
              <div id="source-repos" class="source-repos"></div>
            </div>
            <div id="source-detail" class="source-detail"></div>
          </div>
        </section>

        <section id="activity-view" class="view">
          <nav class="subtabs" id="activity-subtabs">
            <button class="subtab active" data-activity-subtab="timeline">Timeline</button>
            <button class="subtab" data-activity-subtab="week">This week</button>
            <button class="subtab" data-activity-subtab="repos">Repositories</button>
          </nav>

          <div id="activity-subview-timeline" class="subview active">
            <nav class="subtabs" id="timeline-filters">
              <button class="subtab active" data-timeline-filter="all">All</button>
              <button class="subtab" data-timeline-filter="runtime">Runtime</button>
              <button class="subtab" data-timeline-filter="git">Git</button>
            </nav>
            <div id="timeline-list" class="overview-recent"></div>
          </div>

          <div id="activity-subview-week" class="subview">
            <h3 class="section-title">This week across all repositories</h3>
            <div class="activity-stats">
              <article><span>Commits (7d)</span><strong id="act-commits">—</strong></article>
              <article><span>Active Days</span><strong id="act-days">—</strong></article>
              <article><span>Ahead</span><strong id="act-ahead">—</strong></article>
              <article><span>Behind</span><strong id="act-behind">—</strong></article>
              <article><span>Changed</span><strong id="act-changed">—</strong></article>
              <article><span>Staged</span><strong id="act-staged">—</strong></article>
              <article><span>Events</span><strong id="act-events">—</strong></article>
              <article><span>Quality</span><strong id="act-quality">—</strong></article>
            </div>
            <div id="quality-strip" class="quality-strip"></div>
          </div>

          <div id="activity-subview-repos" class="subview">
            <div class="activity-toolbar">
              <div>
                <strong>Tracked Git repositories</strong>
                <small id="activity-identity">Loading identity...</small>
              </div>
              <label class="switch-row">
                <input id="mine-only-toggle" type="checkbox" checked>
                <span>My commits only</span>
              </label>
            </div>
            <div id="activity-note" class="activity-note"></div>
            <div id="repos-list" class="repos-list"></div>
          </div>
        </section>

        <section id="resources-view" class="view">
          <p class="subview-desc">Live machine resources — CPU, memory, swap, disk, and network, plus GPU/battery/thermal where macOS exposes them without elevated privileges. Rescanned every few seconds while this tab is open.</p>
          <div id="resources-content"></div>
        </section>

        <section id="tools-view" class="view">
          <p class="subview-desc">Detects installed package-manager/CLI tools and their versions, and flags discovered projects whose own manifest (package.json, go.mod, Cargo.toml, ...) needs a tool that isn't installed. Install/Update run through Homebrew and always ask for confirmation first.</p>
          <button id="tools-refresh" class="btn-secondary">Refresh</button>
          <div id="tools-content"></div>
        </section>

        <section id="servers-view" class="view">
          <p class="subview-desc">SSH-managed servers you've added by hand (host, user, port, and a path to an existing .pem/key file — Thaloca never reads or stores the key's contents). "Check" runs a read-only diagnostic (uptime, memory, disk, Docker). "Containers" lists Docker containers on that server with Start/Stop/Restart/Logs. "Terminal" opens a real interactive SSH session, like opening a terminal to it yourself — there's no per-keystroke confirmation, so only run commands you'd run there directly.</p>
          <div id="servers-content"></div>
        </section>

      </main>
      <aside id="inspector-panel" class="inspector-panel"></aside>
    </div>
  `
  bindEvents()
}

function switchView(view: string) {
  document.querySelectorAll('.nav-btn, .view').forEach(el => el.classList.remove('active'))
  document.querySelector(`.nav-btn[data-view="${view}"]`)?.classList.add('active')
  document.getElementById(`${view}-view`)?.classList.add('active')
  const titles: Record<string, string> = { overview: 'Overview', runtime: 'Runtime', source: 'Source Control', activity: 'Activity', resources: 'Resources', tools: 'Tools', servers: 'Servers' }
  document.getElementById('view-title')!.textContent = titles[view] || view
  closeServiceInspector()

  // Resource Monitor only polls while its own tab is visible — CPU/memory
  // reads are cheap, but there is no reason to keep sampling network rates
  // for a view nobody is looking at.
  if (view === 'resources') {
    if (!resourcesTimer) {
      void loadResources()
      resourcesTimer = window.setInterval(loadResources, 5000)
    }
  } else if (resourcesTimer) {
    window.clearInterval(resourcesTimer)
    resourcesTimer = null
  }

  // Tools & Packages is detection-only (no live values to poll) — load once
  // per visit, with a manual Refresh button for after installing something.
  if (view === 'tools' && !tools) {
    void loadTools()
  }

  // The server list is just a local config read — cheap enough to reload
  // on every visit rather than caching it.
  if (view === 'servers') {
    void loadServers()
  }
}

let resourcesTimer: number | null = null
let installedApps: InstalledApp[] = []
let resourceHistory: ResourceSample[] = []
let historyWindow: HistoryWindow = '1h'

async function loadResources(): Promise<void> {
  const [snapshot, apps, history] = await Promise.all([api.resources(), api.installedApps(), api.resourceHistory(historyWindow)])
  resources = snapshot
  installedApps = apps
  resourceHistory = history
  renderResources()
}

function handleHistoryWindowChange(window: HistoryWindow): void {
  historyWindow = window
  void api.resourceHistory(historyWindow).then(history => {
    resourceHistory = history
    renderResources()
  })
}

async function handleOpenApp(appPath: string): Promise<void> {
  try {
    await api.openInstalledApp(appPath)
  } catch (error) {
    showError(`Could not open app: ${String(error)}`)
    return
  }
  await loadResources()
}

async function handleQuitApp(bundleId: string): Promise<void> {
  if (!(await api.confirmDialog('Quit application', 'Quit this application? Any unsaved work in it will be lost.'))) return
  try {
    await api.quitInstalledApp(bundleId)
  } catch (error) {
    showError(`Could not quit app: ${String(error)}`)
    return
  }
  await loadResources()
}

async function loadTools(): Promise<void> {
  tools = await api.tools()
  renderTools()
}

async function refreshTools(button?: HTMLButtonElement): Promise<void> {
  // Re-running the scan with nothing changed on the machine yields the
  // same data as before, which otherwise looks like the button did
  // nothing — this gives immediate, visible feedback that it ran.
  if (button) {
    button.disabled = true
    button.textContent = 'Refreshing…'
  }
  try {
    tools = await api.refreshTools()
    renderTools()
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = 'Refresh'
    }
  }
}

function renderTools(): void {
  renderToolsView(tools, toolAction)
  // The output panel's innerHTML (and its scroll position) is recreated on
  // every poll tick while a job runs, which otherwise fights any attempt to
  // scroll it — keep it pinned to the latest output instead, like a
  // live/tail log.
  if (toolAction?.status.running) {
    const output = document.querySelector<HTMLElement>('.tool-action-output')
    if (output) output.scrollTop = output.scrollHeight
  }
}

let toolAction: ToolActionState | null = null
let toolActionTimer: number | null = null

async function handleToolAction(button: HTMLButtonElement): Promise<void> {
  const tool = button.dataset.toolInstall || button.dataset.toolUpdate || ''
  const action: 'install' | 'update' = button.dataset.toolInstall ? 'install' : 'update'
  const name = button.dataset.toolName || tool
  const command = button.dataset.toolCommand || ''
  if (!tool || !command) return
  if (toolAction?.status.running) {
    showError(`${toolAction.name} is still running — wait for it to finish first.`)
    return
  }

  const verb = action === 'install' ? 'Install' : 'Update'
  if (!(await api.confirmDialog(`${verb} ${name}`, `Run this command now?\n\n${command}`))) return

  let jobID: string
  try {
    jobID = await api.runToolAction(tool, action)
  } catch (error) {
    showError(`Could not start ${action} for ${name}: ${String(error)}`)
    return
  }

  toolAction = { tool, name, action, command, status: { running: true, output: '', exit_code: 0 } }
  renderTools()

  if (toolActionTimer) window.clearInterval(toolActionTimer)
  toolActionTimer = window.setInterval(async () => {
    if (!toolAction) return
    const status = await api.toolActionStatus(jobID)
    toolAction = { ...toolAction, status }
    renderTools()
    if (!status.running) {
      if (toolActionTimer) window.clearInterval(toolActionTimer)
      toolActionTimer = null
      // The job just changed reality (installed a tool, bumped a version);
      // pull the fresh state for the grid. The panel itself stays up so
      // the user can still read the output until they close it.
      tools = await api.tools()
      renderTools()
    }
  }, 700)
}

function closeToolAction(): void {
  toolAction = null
  if (toolActionTimer) {
    window.clearInterval(toolActionTimer)
    toolActionTimer = null
  }
  renderTools()
}

async function loadServers(): Promise<void> {
  servers = await api.listServers()
  renderServers()
  rebuildCommandIndex()
}

function renderServers(): void {
  renderServersView({ servers, checks: serverChecks, keyWarnings: serverKeyWarnings, containers: serverContainers, terminal: serverTerminal, showAddForm: showAddServerForm })
  // The terminal panel re-renders its innerHTML on every state change like
  // everything else here, but the xterm.js instance itself lives outside
  // that cycle — reattach it into whatever mount point this render just
  // produced so scrollback survives instead of the session being recreated.
  if (serverTerminal) {
    const mount = document.querySelector<HTMLElement>(`[data-server-terminal-mount="${CSS.escape(serverTerminal.serverId)}"]`)
    if (mount) reattachServerTerminal(serverTerminal.serverId, mount)
  }
}

function toggleAddServerForm(): void {
  showAddServerForm = !showAddServerForm
  renderServers()
}

async function handleAddServer(button: HTMLButtonElement): Promise<void> {
  const form = button.closest('.server-add-form')
  const field = (name: string) => (form?.querySelector(`[data-field="${name}"]`) as HTMLInputElement | null)?.value.trim() || ''
  const name = field('name')
  const host = field('host')
  const port = Number(field('port')) || 0
  const user = field('user')
  const keyPath = field('keyPath')
  const environment = (form?.querySelector('[data-field="environment"]') as HTMLSelectElement | null)?.value.trim() || ''
  if (!host || !user || !keyPath) {
    showError('Host, SSH user, and key path are required.')
    return
  }
  try {
    await api.addServer(name, host, port, user, keyPath, environment)
  } catch (error) {
    showError(`Could not add server: ${String(error)}`)
    return
  }
  showAddServerForm = false
  await loadServers()
}

async function handleRemoveServer(id: string): Promise<void> {
  const server = servers.find(s => s.id === id)
  if (!(await api.confirmDialog('Remove server', `Remove "${server?.name || id}" from Thaloca? This only forgets it here — nothing changes on the server itself.`))) return
  await api.removeServer(id)
  serverChecks.delete(id)
  serverKeyWarnings.delete(id)
  serverContainers.delete(id)
  if (serverTerminal?.serverId === id) {
    serverTerminal = null
    void closeServerTerminal()
  }
  await loadServers()
}

async function handleCheckServer(id: string): Promise<void> {
  serverChecks.set(id, 'checking')
  renderServers()
  const [result, warning] = await Promise.all([api.checkServer(id), api.keyPermissionWarning(id)])
  serverChecks.set(id, result)
  if (warning) {
    serverKeyWarnings.set(id, warning)
  } else {
    serverKeyWarnings.delete(id)
  }
  renderServers()
}

async function handleFixServerKey(id: string): Promise<void> {
  if (!(await api.confirmDialog('Fix key permissions', 'chmod this private key file to 0600 (owner read/write only)? This only changes the file\'s permission bits, never its contents.'))) return
  try {
    await api.fixServerKeyPermissions(id)
  } catch (error) {
    showError(`Could not fix key permissions: ${String(error)}`)
    return
  }
  serverKeyWarnings.delete(id)
  renderServers()
}

async function toggleServerContainers(id: string): Promise<void> {
  if (serverContainers.has(id)) {
    serverContainers.delete(id)
    renderServers()
    return
  }
  serverContainers.set(id, { status: 'loading', items: [] })
  renderServers()
  try {
    const items = await api.listServerContainers(id)
    serverContainers.set(id, { status: 'loaded', items })
  } catch (error) {
    serverContainers.set(id, { status: 'error', items: [], error: String(error) })
  }
  renderServers()
}

async function handleServerContainerAction(serverId: string, containerId: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const verbs: Record<string, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' }
  if (!(await api.confirmDialog(`${verbs[action]} container`, `${verbs[action]} this container on the remote server?`))) return
  try {
    if (action === 'start') await api.startServerContainer(serverId, containerId)
    else if (action === 'stop') await api.stopServerContainer(serverId, containerId)
    else await api.restartServerContainer(serverId, containerId)
  } catch (error) {
    showError(`Could not ${action} container: ${String(error)}`)
  }
  const current = serverContainers.get(serverId)
  if (!current) return
  try {
    const items = await api.listServerContainers(serverId)
    serverContainers.set(serverId, { ...current, status: 'loaded', items })
  } catch (error) {
    serverContainers.set(serverId, { ...current, status: 'error', error: String(error) })
  }
  renderServers()
}

async function handleServerContainerLogs(serverId: string, containerId: string): Promise<void> {
  const current = serverContainers.get(serverId)
  if (!current) return
  if (current.logs?.containerId === containerId) {
    serverContainers.set(serverId, { ...current, logs: null })
    renderServers()
    return
  }
  serverContainers.set(serverId, { ...current, logs: { containerId, text: 'Loading logs…' } })
  renderServers()
  let text: string
  try {
    text = await api.serverContainerLogs(serverId, containerId)
  } catch (error) {
    text = String(error)
  }
  const latest = serverContainers.get(serverId)
  if (!latest) return
  serverContainers.set(serverId, { ...latest, logs: { containerId, text } })
  renderServers()
}

async function toggleServerTerminal(id: string): Promise<void> {
  if (serverTerminal?.serverId === id) {
    serverTerminal = null
    renderServers()
    await closeServerTerminal()
    return
  }

  serverTerminal = { serverId: id, status: 'connecting' }
  renderServers()

  const mount = document.querySelector<HTMLElement>(`[data-server-terminal-mount="${CSS.escape(id)}"]`)
  if (!mount) return
  await openServerTerminal(id, mount, (status: ServerTerminalStatus, detail?: string) => {
    if (!serverTerminal || serverTerminal.serverId !== id) return
    serverTerminal = { serverId: id, status, detail }
    renderServers()
  })
}

function bindEvents() {
  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view') || 'overview'))
  })

  document.getElementById('tools-refresh')!.addEventListener('click', event => { void refreshTools(event.currentTarget as HTMLButtonElement) })

  document.getElementById('fullscreen-btn')!.addEventListener('click', () => { void api.toggleFullscreen() })
  document.getElementById('settings-btn')!.addEventListener('click', () => { void openSettingsPanel() })
  document.getElementById('clipboard-btn')!.addEventListener('click', () => { void openClipboardHistoryPanel() })

  initDiffCommentDrag()

  // Command palette (⌘K) and the Service Inspector's own action buttons
  // both need a rescan afterwards; the inspector dispatches this event
  // instead of importing loadRuntime directly to avoid a circular import.
  initCommandPalette()
  initSettingsPanel()
  initClipboardHistoryPanel()
  document.addEventListener('thaloca:refresh', () => { void refreshRuntime() })
  // views/timeline.ts dispatches this instead of calling switchView/
  // loadRepoTab/openServiceInspector directly, for the same reason as above.
  document.addEventListener(TIMELINE_NAVIGATE_EVENT, event => {
    navigateToTimelineTarget((event as CustomEvent<TimelineRow>).detail)
  })
  // views/sourceControl.ts dispatches this after a fetch/pull/push/stash —
  // ahead/behind/changed counts live in `activity`, owned here.
  document.addEventListener(ACTIVITY_REFRESH_EVENT, () => { void loadActivity() })

  // Source Control repo filter (static input, so typing never loses focus)
  document.getElementById('source-filter')?.addEventListener('input', event => {
    setSourceFilter((event.target as HTMLInputElement).value)
  })

  // Refresh
  document.getElementById('refresh-btn')!.addEventListener('click', loadAll)
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('change', handleDocumentChange)
  document.addEventListener('input', handleBranchFilterInput)
  document.addEventListener('input', event => {
    const target = event.target as HTMLInputElement | null
    if (target?.id === 'pr-filter-search') handlePRSearchInput(target)
  })

  // Search filters the lists of whichever view is open.
  document.getElementById('search-input')!.addEventListener('input', event => {
    searchQuery = (event.target as HTMLInputElement).value.trim().toLowerCase()
    renderServices()
    renderPorts()
    renderJobs()
    renderActivity()
    // Resources' process table can be hundreds of rows — only worth
    // rebuilding while that tab is actually the one showing.
    if (resourcesTimer) renderResources()
  })

  // Sub-tabs inside Runtime
  document.querySelectorAll('#services-subtabs .subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#services-subtabs .subtab, #runtime-view .subview').forEach(el => el.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`subview-${btn.getAttribute('data-subtab')}`)!.classList.add('active')
    })
  })

  // Sub-tabs inside Activity (Timeline vs This week)
  document.querySelectorAll('#activity-subtabs .subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#activity-subtabs .subtab, #activity-view .subview').forEach(el => el.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`activity-subview-${btn.getAttribute('data-activity-subtab')}`)!.classList.add('active')
    })
  })

  // Timeline category filter inside Activity
  document.querySelectorAll('#timeline-filters .subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#timeline-filters .subtab').forEach(el => el.classList.remove('active'))
      btn.classList.add('active')
      timelineFilter = (btn.getAttribute('data-timeline-filter') || 'all') as typeof timelineFilter
      renderTimeline()
    })
  })

  // Initial load
  loadAll()

  // Auto-refresh only runtime data. Git activity is intentionally not polled:
  // it refreshes on app load, manual refresh, or future git event hooks.
  refreshTimer = window.setInterval(loadRuntime, 30_000)
}

async function loadAll() {
  showLoading('docker-list')
  showLoading('ports-list')
  showLoading('repos-list')
  showLoading('jobs-list')

  try {
    // Services scan and git activity are independent — run them together
    // so the Activity dashboard is not stuck behind the runtime scan.
    void refreshGHStatus()
    await Promise.all([loadRuntime(), loadActivity()])
  } catch (error) {
    showError(String(error))
  }
}

let runtimeInFlight: Promise<void> | null = null

function loadRuntime(): Promise<void> {
  if (!runtimeInFlight) {
    runtimeInFlight = doLoadRuntime().finally(() => { runtimeInFlight = null })
  }
  return runtimeInFlight
}

// After a mutating action (start/stop), an already-running scan holds data
// from before the action — wait for it, then scan again for fresh state.
async function refreshRuntime(): Promise<void> {
  if (runtimeInFlight) {
    try { await runtimeInFlight } catch { /* previous scan errors are already shown */ }
  }
  return loadRuntime()
}

async function doLoadRuntime() {
  // One discovery pass (App.Snapshot) covers services/ports/jobs plus the
  // project grouping and anomaly detection Overview needs — previously
  // these were 4 separate bindings the frontend always called together,
  // with Overview redoing the same service/job discovery the other three
  // had just done.
  const snapshot = await api.snapshot()
  services = normalizeServices(snapshot.services)
  ports = normalizePorts(snapshot.ports)
  jobs = normalizeJobs(snapshot.jobs)
  renderServices()
  renderPorts()
  renderJobs()

  // Overview/Incidents are derived server-side (grouping + anomaly
  // detection); nothing here is persisted, it is recomputed on every scan.
  overview = { projects: snapshot.projects, anomalies: snapshot.anomalies, scanned_at: snapshot.scanned_at }
  renderOverview()
  rebuildCommandIndex()

  await checkAllHealth()
  renderServices()

  // Runtime/health/action events recorded during this scan (in-memory only,
  // see App.RecentEvents in desktop/app.go).
  await loadTimeline()
}

// Overview's Runtime/Source summary lines are derived from data already
// loaded for the Runtime view and the Activity dashboard — never triggers
// its own scan.
function renderOverview(): void {
  renderOverviewView(overview, { services, ports, jobs, activity })
}

function rebuildCommandIndex(): void {
  const viewItems: CommandItem[] = [
    { id: 'view:overview', label: 'Go to Overview', kind: 'view', run: () => switchView('overview') },
    { id: 'view:runtime', label: 'Go to Runtime', kind: 'view', run: () => switchView('runtime') },
    { id: 'view:source', label: 'Go to Source Control', kind: 'view', run: () => switchView('source') },
    { id: 'view:activity', label: 'Go to Activity', kind: 'view', run: () => switchView('activity') },
    { id: 'view:resources', label: 'Go to Resources', kind: 'view', run: () => switchView('resources') },
    { id: 'view:tools', label: 'Go to Tools', kind: 'view', run: () => switchView('tools') },
    { id: 'view:servers', label: 'Go to Servers', kind: 'view', run: () => switchView('servers') },
  ]
  const serviceItems: CommandItem[] = services.map(s => ({
    id: `service:${s.id}`,
    label: s.name,
    hint: s.project || s.source,
    kind: 'service',
    run: () => openServiceInspector(s),
  }))
  const runningDockerServices = services.filter(s => s.source === 'docker' && s.status !== 'stopped')
  const actionItems: CommandItem[] = [
    ...runningDockerServices.map((s): CommandItem => ({
      id: `action:restart:${s.id}`,
      label: `Restart ${s.name}`,
      hint: 'docker restart',
      kind: 'action',
      run: () => { void runServiceAction(s, 'restart') },
    })),
    ...runningDockerServices.map((s): CommandItem => ({
      id: `action:stop:${s.id}`,
      label: `Stop ${s.name}`,
      hint: 'docker stop',
      kind: 'action',
      run: () => { void runServiceAction(s, 'stop') },
    })),
  ]
  const repoItems: CommandItem[] = (activity?.repositories || []).map(r => ({
    id: `repo:${r.path}`,
    label: `Open repo: ${r.name}`,
    hint: r.branch,
    kind: 'action',
    run: () => { switchView('source'); void openRepoInSourceControl(r.path) },
  }))
  const serverItems: CommandItem[] = servers.flatMap(s => [
    {
      id: `server:check:${s.id}`,
      label: `Check ${s.name}`,
      hint: 'SSH health check',
      kind: 'action' as const,
      run: () => { switchView('servers'); void handleCheckServer(s.id) },
    },
    {
      id: `server:terminal:${s.id}`,
      label: `Open terminal: ${s.name}`,
      hint: 'SSH',
      kind: 'action' as const,
      run: () => { switchView('servers'); void toggleServerTerminal(s.id) },
    },
  ])
  setCommandPaletteIndex([...viewItems, ...serviceItems, ...actionItems, ...repoItems, ...serverItems])
}

async function loadActivity() {
  activity = normalizeActivity(await api.getActivity())
  renderActivity()
  renderSourceView(activity)
  renderOverview()
  renderTimeline()
  rebuildCommandIndex()
}

async function handleDocumentClick(event: Event) {
  const target = event.target as HTMLElement | null

  // Pin toggles live inside the repo button, so they must win first.
  const pin = target?.closest<HTMLElement>('[data-pin-repo]')
  if (pin?.dataset.pinRepo) {
    togglePinRepo(pin.dataset.pinRepo)
    return
  }
  const button = target?.closest<HTMLButtonElement>('[data-ignore-repo], [data-track-repo], [data-enable-events], [data-disable-events], [data-stop-pid], [data-stop-container], [data-start-container], [data-restart-container], [data-terminal-container], [data-container-logs], [data-job-logs], [data-project-logs], [data-process-logs], [data-start-project], [data-stop-project], [data-restart-project], [data-down-project], [data-repo-tab], [data-branch-create], [data-branch-switch], [data-branch-merge], [data-branch-delete], [data-file-nav], [data-file-open], [data-file-close], [data-pr-view], [data-pr-back], [data-pr-review], [data-pr-state-tab], [data-pr-new-toggle], [data-pr-new-cancel], [data-pr-new-submit], [data-pr-merge], [data-pr-close], [data-pr-reopen], [data-pr-ready], [data-pr-labels-toggle], [data-pr-labels-cancel], [data-pr-labels-save], [data-pr-request-reviewers], [data-pr-diff-view], [data-pr-detail-tab], [data-pr-select-file], [data-pr-comment-add], [data-pr-comment-cancel], [data-pr-comment-submit], [data-pr-comment-reply], [data-source-repo], [data-stage], [data-unstage], [data-resolve], [data-commit], [data-diff-file], [data-diff-view-toggle], [data-commit-view], [data-commit-back], [data-commit-file], [data-gh-open], [data-gh-cancel], [data-gh-login], [data-gh-logout], [data-gh-save-client], [data-gh-save-token], [data-gh-cli], [data-sync], [data-history-more], [data-graph-more], [data-branch-more], [data-tool-install], [data-tool-update], [data-tool-action-close], [data-server-add-toggle], [data-server-add-submit], [data-server-remove], [data-server-check], [data-server-terminal-toggle], [data-server-browse-key], [data-open-external], [data-server-fix-key], [data-server-containers-toggle], [data-server-container-start], [data-server-container-stop], [data-server-container-restart], [data-server-container-logs], [data-resource-sort], [data-open-app], [data-quit-app], [data-history-window]')
  if (!button) {
    // Activity dashboard: clicking a repo expands its recent commits/events
    // inline instead of navigating away — "Open in Source Control" (below)
    // is still there for when the user actually wants to work on it.
    const repoOpen = target?.closest<HTMLElement>('[data-open-source]')
    if (repoOpen?.dataset.openSource) {
      const path = repoOpen.dataset.openSource
      expandedActivityRepo = expandedActivityRepo === path ? null : path
      renderActivity()
      return
    }
    const sourceJump = target?.closest<HTMLElement>('[data-activity-open-source]')
    if (sourceJump?.dataset.activityOpenSource) {
      switchView('source')
      await openRepoInSourceControl(sourceJump.dataset.activityOpenSource)
      return
    }
    const projectToggle = target?.closest<HTMLElement>('[data-toggle-project]')
    if (projectToggle?.dataset.toggleProject) {
      toggleProjectExpanded(projectToggle.dataset.toggleProject)
      renderServices()
    }
    return
  }

  if (button.dataset.openExternal) {
    // A plain <a target="_blank"> silently does nothing in Wails' WKWebView
    // (no window.open handler is wired up), so external links must go
    // through the runtime's own BrowserOpenURL instead.
    BrowserOpenURL(button.dataset.openExternal)
    return
  }

  if (button.dataset.toolInstall || button.dataset.toolUpdate) {
    await handleToolAction(button)
    return
  }

  if (button.dataset.toolActionClose !== undefined) {
    closeToolAction()
    return
  }

  if (button.dataset.serverAddToggle !== undefined) {
    toggleAddServerForm()
    return
  }

  if (button.dataset.serverAddSubmit !== undefined) {
    await handleAddServer(button)
    return
  }

  if (button.dataset.serverRemove) {
    await handleRemoveServer(button.dataset.serverRemove)
    return
  }

  if (button.dataset.serverCheck) {
    await handleCheckServer(button.dataset.serverCheck)
    return
  }

  if (button.dataset.serverTerminalToggle) {
    await toggleServerTerminal(button.dataset.serverTerminalToggle)
    return
  }

  if (button.dataset.serverFixKey) {
    await handleFixServerKey(button.dataset.serverFixKey)
    return
  }

  if (button.dataset.serverContainersToggle) {
    await toggleServerContainers(button.dataset.serverContainersToggle)
    return
  }

  if (button.dataset.serverContainerStart) {
    await handleServerContainerAction(button.dataset.serverContainerStart, button.dataset.containerId || '', 'start')
    return
  }

  if (button.dataset.serverContainerStop) {
    await handleServerContainerAction(button.dataset.serverContainerStop, button.dataset.containerId || '', 'stop')
    return
  }

  if (button.dataset.serverContainerRestart) {
    await handleServerContainerAction(button.dataset.serverContainerRestart, button.dataset.containerId || '', 'restart')
    return
  }

  if (button.dataset.serverContainerLogs) {
    await handleServerContainerLogs(button.dataset.serverContainerLogs, button.dataset.containerId || '')
    return
  }

  if (button.dataset.resourceSort) {
    handleResourceSort(button.dataset.resourceSort as ProcessSort['by'])
    return
  }

  if (button.dataset.openApp) {
    await handleOpenApp(button.dataset.openApp)
    return
  }

  if (button.dataset.quitApp) {
    await handleQuitApp(button.dataset.quitApp)
    return
  }

  if (button.dataset.historyWindow) {
    handleHistoryWindowChange(button.dataset.historyWindow as HistoryWindow)
    return
  }

  if (button.dataset.serverBrowseKey !== undefined) {
    const path = await api.pickKeyFile()
    if (path) {
      const input = button.closest('.server-add-field')?.querySelector('[data-field="keyPath"]') as HTMLInputElement | null
      if (input) input.value = path
    }
    return
  }

  if (button.dataset.jobLogs || button.dataset.containerLogs) {
    await handleJobLogs(button.dataset.jobLogs || button.dataset.containerLogs || '')
    return
  }

  if (button.dataset.projectLogs) {
    await handleProjectLogs(button.dataset.projectLogs)
    return
  }

  if (button.dataset.processLogs) {
    await handleProcessLogs(button.dataset.processLogs)
    return
  }

  if (button.dataset.sourceRepo) {
    await openRepoInSourceControl(button.dataset.sourceRepo)
    return
  }

  if (button.dataset.ghOpen || button.dataset.ghCancel || button.dataset.ghLogin || button.dataset.ghLogout || button.dataset.ghSaveClient || button.dataset.ghSaveToken || button.dataset.ghCli) {
    await handleGHAction(button)
    return
  }

  if (button.dataset.sync) {
    await handleSyncAction(button)
    return
  }

  if (button.dataset.historyMore || button.dataset.graphMore || button.dataset.branchMore) {
    await handleLoadMore(button)
    return
  }

  if (button.dataset.diffViewToggle) {
    handleDiffViewToggle(button)
    return
  }

  if (button.dataset.commitView || button.dataset.commitBack || button.dataset.commitFile !== undefined) {
    await handleCommitAction(button)
    return
  }

  if (button.dataset.stage || button.dataset.unstage || button.dataset.resolve || button.dataset.commit || button.dataset.diffFile !== undefined) {
    await handleChangesAction(button)
    return
  }

  if (button.dataset.repoTab && button.dataset.repo) {
    await loadRepoTab(button.dataset.repo, button.dataset.repoTab as RepoDetail['tab'])
    return
  }

  if (button.dataset.branchCreate || button.dataset.branchSwitch || button.dataset.branchMerge || button.dataset.branchDelete) {
    await handleBranchAction(button)
    return
  }

  if (button.dataset.fileNav !== undefined || button.dataset.fileOpen || button.dataset.fileClose) {
    await handleFileAction(button)
    return
  }

  if (button.dataset.prView || button.dataset.prBack || button.dataset.prReview
    || button.dataset.prStateTab || button.dataset.prNewToggle || button.dataset.prNewCancel || button.dataset.prNewSubmit
    || button.dataset.prMerge || button.dataset.prClose || button.dataset.prReopen || button.dataset.prReady
    || button.dataset.prLabelsToggle || button.dataset.prLabelsCancel || button.dataset.prLabelsSave
    || button.dataset.prRequestReviewers || button.dataset.prDiffView
    || button.dataset.prDetailTab || button.dataset.prSelectFile || button.dataset.prCommentAdd
    || button.dataset.prCommentCancel || button.dataset.prCommentSubmit || button.dataset.prCommentReply) {
    await handlePRAction(button)
    return
  }

  if (button.dataset.startProject || button.dataset.stopProject || button.dataset.restartProject) {
    await handleProjectAction(button)
    return
  }

  if (button.dataset.downProject) {
    const project = button.dataset.downProject
    if (!(await api.confirmDialog('Compose down', `Run docker compose down on "${project}"? This stops AND removes its containers (volumes are kept).`))) return
    const targets = normalizeServices(services).filter(s => s.source === 'docker'
      && (s.project || 'standalone containers') === project && s.container_id)
    for (const svc of targets) pendingContainers.set(svc.container_id, 'removing')
    pendingProjects.set(project, 'removing')
    button.disabled = true
    renderServices()
    try {
      await api.composeDown(project)
    } catch (error) {
      showError(String(error))
    }
    for (const svc of targets) pendingContainers.delete(svc.container_id)
    pendingProjects.delete(project)
    await refreshRuntime()
    return
  }

  if (button.dataset.terminalContainer) {
    try {
      await api.openContainerTerminal(button.dataset.terminalContainer)
    } catch (error) {
      showError(String(error))
    }
    return
  }

  if (button.dataset.stopPid || button.dataset.stopContainer || button.dataset.startContainer || button.dataset.restartContainer) {
    await handleContainerOrProcessAction(button)
    return
  }

  const path = button.dataset.ignoreRepo || button.dataset.trackRepo || button.dataset.enableEvents || button.dataset.disableEvents || ''
  if (!path) return

  showLoading('repos-list')
  try {
    if (button.dataset.ignoreRepo) {
      activity = normalizeActivity(await api.ignoreRepository(path))
    } else if (button.dataset.trackRepo) {
      activity = normalizeActivity(await api.trackRepository(path))
    } else if (button.dataset.enableEvents) {
      activity = normalizeActivity(await api.enableGitEvents(path))
    } else {
      activity = normalizeActivity(await api.disableGitEvents(path))
    }
    renderActivity()
    renderSourceView(activity)
  } catch (error) {
    showError(String(error))
  }
}

async function handleJobLogs(containerID: string) {
  if (jobLogs.has(containerID)) {
    jobLogs.delete(containerID)
    renderJobs()
    renderServices()
    return
  }
  jobLogs.set(containerID, 'Loading logs...')
  renderJobs()
  renderServices()
  try {
    jobLogs.set(containerID, String(await api.containerLogs(containerID) || 'No log output.'))
  } catch (error) {
    jobLogs.set(containerID, `Could not read logs: ${String(error)}`)
  }
  renderJobs()
  renderServices()
}

async function handleProjectLogs(project: string) {
  if (projectLogs.has(project)) {
    projectLogs.delete(project)
    renderServices()
    return
  }
  projectLogs.set(project, 'Loading logs...')
  renderServices()
  try {
    projectLogs.set(project, String(await api.projectLogs(project) || 'No log output.'))
  } catch (error) {
    projectLogs.set(project, `Could not read logs: ${String(error)}`)
  }
  renderServices()
}

async function handleProcessLogs(pid: string) {
  if (processLogs.has(pid)) {
    processLogs.delete(pid)
    renderServices()
    return
  }
  processLogs.set(pid, 'Loading logs...')
  renderServices()
  try {
    processLogs.set(pid, String(await api.processLogs(Number(pid)) || 'No log output.'))
  } catch (error) {
    processLogs.set(pid, `Could not read logs: ${String(error)}`)
  }
  renderServices()
}

async function handleProjectAction(button: HTMLButtonElement) {
  const isStart = Boolean(button.dataset.startProject)
  const isRestart = Boolean(button.dataset.restartProject)
  const project = button.dataset.startProject || button.dataset.stopProject || button.dataset.restartProject || ''
  // Restart applies to every container (docker restart also starts stopped
  // ones); start only targets stopped, stop only running.
  const targets = normalizeServices(services).filter(s => s.source === 'docker'
    && (s.project || 'standalone containers') === project
    && (isRestart ? true : isStart ? s.status === 'stopped' : s.status !== 'stopped')
    && s.container_id)
  if (!targets.length) return

  if (isRestart) {
    if (!(await api.confirmDialog('Restart project', `Restart all ${targets.length} container(s) of "${project}"? Stopped ones are started too.`))) return
  } else if (!isStart) {
    if (!(await api.confirmDialog('Stop project', `Stop ${targets.length} running container(s) of "${project}"?`))) return
  }

  const pendingLabel = isStart ? 'starting' : isRestart ? 'restarting' : 'stopping'
  for (const svc of targets) pendingContainers.set(svc.container_id, pendingLabel)
  // Also tracked at the project level so the header (Start all/Stop all/...)
  // visibly shows progress even while the project's containers are
  // collapsed and not individually visible.
  pendingProjects.set(project, pendingLabel)
  button.disabled = true
  renderServices()

  // Run in parallel: one slow container must not stall the whole project.
  const results = await Promise.allSettled(targets.map(svc =>
    isStart ? api.startContainer(svc.container_id)
      : isRestart ? api.restartContainer(svc.container_id)
        : api.stopContainer(svc.container_id)))
  const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
  if (failures.length) {
    showError(`${failures.length}/${targets.length} container(s) failed: ${String(failures[0].reason)}`)
  }
  for (const svc of targets) pendingContainers.delete(svc.container_id)
  pendingProjects.delete(project)
  await refreshRuntime()
}

async function handleContainerOrProcessAction(button: HTMLButtonElement) {
  const containerID = button.dataset.startContainer || button.dataset.restartContainer || button.dataset.stopContainer || ''
  try {
    if (button.dataset.startContainer) {
      pendingContainers.set(containerID, 'starting')
      renderServices()
      await api.startContainer(containerID)
    } else if (button.dataset.restartContainer) {
      if (!(await api.confirmDialog('Restart container', 'Restart this container?'))) return
      pendingContainers.set(containerID, 'restarting')
      renderServices()
      await api.restartContainer(containerID)
    } else if (button.dataset.stopContainer) {
      if (!(await api.confirmDialog('Stop container', 'Stop this container?'))) return
      pendingContainers.set(containerID, 'stopping')
      renderServices()
      await api.stopContainer(containerID)
    } else {
      if (!(await api.confirmDialog('Stop process', 'Stop this process?'))) return
      await api.stopProcess(Number(button.dataset.stopPid || 0))
    }
  } catch (error) {
    const port = parsePortConflict(String(error))
    const owner = port !== null ? ports.find(p => p.port === port) : undefined
    if (port !== null && owner) {
      showPortConflictAssistant(port, owner, () => { void refreshRuntime() })
    } else {
      showError(String(error))
    }
  }
  if (containerID) pendingContainers.delete(containerID)
  await refreshRuntime()
}

async function handleDocumentChange(event: Event) {
  const target = event.target as HTMLInputElement | null
  if (target?.id === 'pr-filter-author' || target?.id === 'pr-filter-label') {
    await handlePRFilterSelectChange(target as unknown as HTMLSelectElement)
    return
  }
  if (target?.id !== 'mine-only-toggle') return
  showLoading('repos-list')
  try {
    activity = normalizeActivity(await api.setMineOnly(target.checked))
    renderActivity()
    renderSourceView(activity)
  } catch (error) {
    showError(String(error))
  }
}

// Thin wrappers so the ~20 existing call sites keep calling renderServices()/
// renderPorts()/renderJobs()/checkAllHealth() unchanged, while the actual
// rendering lives in views/runtime.ts (data-in, no closure over this
// module's state — see that file's header comment).
function renderServices(): void {
  renderServicesView({ services, ports, jobs, searchQuery, healthCache, pendingContainers, jobLogs, projectLogs, processLogs, pendingProjects })
}
function renderPorts(): void {
  renderPortsView(ports, searchQuery)
}
function renderJobs(): void {
  renderJobsView(jobs, searchQuery, jobLogs)
}
let processSort: ProcessSort = { by: 'cpu', dir: 'desc' }

function renderResources(): void {
  renderResourcesView(resources, searchQuery, processSort, installedApps, resourceHistory, historyWindow)
  const container = document.getElementById('resources-content')
  if (container) wireResourceHistoryHover(container, resourceHistory)
}

function handleResourceSort(key: ProcessSort['by']): void {
  if (processSort.by === key) {
    processSort = { by: key, dir: processSort.dir === 'desc' ? 'asc' : 'desc' }
  } else {
    processSort = { by: key, dir: 'desc' }
  }
  renderResources()
}
async function checkAllHealth(): Promise<void> {
  await checkAllHealthRuntime(services, healthCache)
}

async function loadTimeline() {
  timelineEvents = await api.recentEvents(50)
  renderTimeline()
}

function renderTimeline(): void {
  renderTimelineView(timelineEvents, activity, timelineFilter)
}

// Clicking a timeline row jumps to the view that owns that kind of object,
// per the ownership chosen when Runtime/Source Control were split apart:
// runtime targets open in Runtime (Service Inspector when a match is still
// discovered), git targets open the repo in Source Control.
function navigateToTimelineTarget(row: TimelineRow) {
  if (row.category === 'git' && row.targetId) {
    switchView('source')
    void openRepoInSourceControl(row.targetId)
    return
  }
  if (row.category === 'health' && row.targetId) {
    switchView('runtime')
    const svc = normalizeServices(services).find(s => s.health_url === row.targetId)
    if (svc) openServiceInspector(svc)
    return
  }
  if (row.targetType === 'job') {
    switchView('runtime')
    document.querySelector<HTMLElement>('#services-subtabs .subtab[data-subtab="jobs"]')?.click()
    return
  }
  if (row.targetType === 'port') {
    switchView('runtime')
    document.querySelector<HTMLElement>('#services-subtabs .subtab[data-subtab="ports"]')?.click()
    return
  }
  if (row.targetType === 'container' && row.targetId) {
    switchView('runtime')
    const svc = normalizeServices(services).find(s => s.container_id === row.targetId)
    if (svc) openServiceInspector(svc)
    return
  }
  switchView('runtime')
}

function renderActivity() {
  if (!activity) return

  document.getElementById('act-commits')!.textContent = String(activity.commit_count)
  document.getElementById('act-days')!.textContent = String(activity.active_days)
  document.getElementById('act-ahead')!.textContent = String(activity.ahead)
  document.getElementById('act-behind')!.textContent = String(activity.behind)
  document.getElementById('act-changed')!.textContent = String(activity.changed_files)
  document.getElementById('act-staged')!.textContent = String(activity.staged_files)
  document.getElementById('act-events')!.textContent = String(activity.event_count)
  document.getElementById('act-quality')!.textContent = activity.quality_score ? String(activity.quality_score) : '—'

  const identity = document.getElementById('activity-identity')!
  const identities = activity.identities || []
  identity.textContent = identities.length
    ? `Tracking ${activity.mine_only ? 'only your commits' : 'all authors'} — your identities: ${identities.join(' · ')}`
    : activity.my_email || activity.my_name
      ? `Tracking ${activity.mine_only ? 'only your commits' : 'all authors'} as ${activity.my_name || activity.my_email}`
      : 'No global git identity found; showing all discovered activity'

  const mineOnlyToggle = document.getElementById('mine-only-toggle') as HTMLInputElement | null
  if (mineOnlyToggle) mineOnlyToggle.checked = activity.mine_only

  const note = document.getElementById('activity-note')!
  if (activity.note) {
    note.textContent = activity.note
    note.classList.add('visible')
  } else {
    note.textContent = ''
    note.classList.remove('visible')
  }

  renderQualityStrip(activity)
  renderRepositories(activity.repositories || [])
}

function renderQualityStrip(activity: ActivitySummary) {
  const container = document.getElementById('quality-strip')!
  container.innerHTML = `
    <article><span>Feat</span><strong>${activity.feature_commits}</strong></article>
    <article><span>Fix</span><strong>${activity.fix_commits}</strong></article>
    <article><span>Docs</span><strong>${activity.docs_commits}</strong></article>
    <article><span>Chore/Test</span><strong>${activity.chore_commits}</strong></article>
    <article><span>Merge</span><strong>${activity.merge_commits}</strong></article>
  `
}

function renderRepositories(repositories: RepositoryActivity[]) {
  const container = document.getElementById('repos-list')!
  if (repositories.length === 0) {
    container.innerHTML = '<div class="empty">No repositories discovered yet.</div>'
    return
  }

  const filtered = repositories.filter(repo => matchesSearch(searchQuery, repo.name, repo.path, repo.branch, repo.identity))
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty compact">No projects match the current search.</div>'
    return
  }

  // Active projects first, then alphabetically; ignored ones sink to the bottom.
  const sorted = [...filtered].sort((a, b) => {
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1
    if ((b.commit_count || 0) !== (a.commit_count || 0)) return (b.commit_count || 0) - (a.commit_count || 0)
    return a.name.localeCompare(b.name)
  })

  container.innerHTML = sorted.map(repo => {
    const expanded = expandedActivityRepo === repo.path
    return `
    <article class="repo-card ${repo.ignored ? 'ignored' : ''} ${expanded ? 'expanded' : ''}">
      <div class="repo-main" data-open-source="${escapeHTML(repo.path)}" title="Show recent activity">
        <div class="repo-title">
          <strong>${escapeHTML(repo.name)}</strong>
          <small>${escapeHTML(repo.path)}</small>
        </div>
        <div class="repo-stats">
          ${repo.branch ? `<span>${escapeHTML(repo.branch)}</span>` : ''}
          <span>${repo.commit_count || 0} commits</span>
          ${repo.identity ? `<span class="repo-identity" title="Git identity used for this repository">${escapeHTML(repo.identity)}</span>` : ''}
          ${repo.event_tracking ? '<span>events on</span>' : ''}
          ${repo.changed_files ? `<span>${repo.changed_files} changed</span>` : ''}
          ${repo.staged_files ? `<span>${repo.staged_files} staged</span>` : ''}
        </div>
        <div class="repo-actions">
          ${repo.event_tracking
            ? `<button class="repo-action" data-disable-events="${escapeHTML(repo.path)}">Disable events</button>`
            : `<button class="repo-action" data-enable-events="${escapeHTML(repo.path)}">Enable events</button>`}
          ${repo.ignored
            ? `<button class="repo-action" data-track-repo="${escapeHTML(repo.path)}">Track</button>`
            : `<button class="repo-action danger" data-ignore-repo="${escapeHTML(repo.path)}">Ignore</button>`}
        </div>
      </div>
      ${expanded ? renderRepoActivityInline(repo) : ''}
    </article>
  `}).join('')
}

// Recent commits/events for one repo, expanded inline in place of jumping
// to Source Control — both lists are already loaded as part of `activity`,
// so this needs no extra backend call.
function renderRepoActivityInline(repo: RepositoryActivity): string {
  const commits = (activity?.commits || []).filter(c => c.repo_path === repo.path).slice(0, 8)
  const events = (activity?.events || []).filter(e => e.repo_path === repo.path).slice(0, 8)
  const rows = [
    ...commits.map(c => ({ at: c.occurred_at, text: `${c.hash.slice(0, 7)} ${c.subject}`, author: c.author })),
    ...events.map(e => ({ at: e.occurred_at, text: `${e.event}${e.subject ? ': ' + e.subject : ''}`, author: e.author })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  return `
    <div class="repo-inline-activity">
      ${rows.length === 0
        ? '<div class="empty compact">No recent commits or events for this repository.</div>'
        : rows.map(r => `
          <div class="repo-inline-row">
            <span class="repo-inline-time">${escapeHTML(formatDate(r.at))}</span>
            <span class="repo-inline-text">${escapeHTML(r.text)}</span>
            <span class="repo-inline-author">${escapeHTML(r.author)}</span>
          </div>`).join('')}
      <button class="repo-action" data-activity-open-source="${escapeHTML(repo.path)}">Open in Source Control →</button>
    </div>`
}

// Initialize
document.addEventListener('DOMContentLoaded', renderApp)

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer)
})
