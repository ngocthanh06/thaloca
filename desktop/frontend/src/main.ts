import {
  api, normalizeActivity, normalizeServices, normalizeJobs, normalizePorts,
  type Service, type PortUsage, type HealthStatus,
  type RepositoryActivity, type ActivitySummary,
  type Job, type OverviewResult, type TimelineEvent, type ResourceSnapshot, type ToolsSnapshot,
  type ServerConnection, type ServerHealth, type RemoteContainer, type InstalledApp, type ResourceSample,
  type SecurityReport, type SSHConfigHost, type RemoteFile, type BrewSearchResult, type BrewPackages, type RegistryPackage,
  type ContainerRuntimeStatus,
} from './api'
import { escapeHTML, formatBytes, formatDuration, formatDate, getStatusClass, getSourceBadgeClass, matchesSearch, showLoading, showError, startGlobalLoading, stopGlobalLoading, hideSplashScreen } from './dom'
import { applyStoredTheme, getTheme, setTheme } from './theme'
import { LOCALE_CHANGE_EVENT, t } from './i18n'
import { renderOverviewView } from './views/overview'
import { renderResourcesView, type ProcessSort } from './views/resources'
import { wireResourceHistoryHover, type HistoryWindow } from './components/resourceCharts'
import { renderToolsView, renderPackagesView, type ToolActionState, type PackageRegistryKey } from './views/tools'
import { initUtilitiesView } from './views/utilities'
import { initEnvFilesView } from './views/envFiles'
import { initConfigFilesView } from './views/configFiles'
import {
  renderServersView, type ServerTerminalState, type ServerContainersState, type ServerCronState,
  type ServerFilesState, type ServerBulkRunState, type ServerBulkRunJobStatus,
} from './views/servers'
import { openServerTerminal, closeServerTerminal, reattachServerTerminal, type ServerTerminalStatus } from './serverTerminal'
import { BrowserOpenURL } from '../wailsjs/runtime/runtime'
import {
  renderServicesView, renderPortsView, renderJobsView, toggleProjectExpanded, expandProject,
  checkAllHealth as checkAllHealthRuntime, renderRuntimeEngineCard,
} from './views/runtime'
import { renderTimelineView, TIMELINE_NAVIGATE_EVENT, type TimelineRow } from './views/timeline'
import {
  renderSourceView, setSourceFilter, openRepoInSourceControl, togglePinRepo,
  loadRepoTab, refreshGHStatus, handleGHAction, handleSyncAction, handleLoadMore,
  handleCommitAction, handleChangesAction, handleDiffViewToggle, handleBranchAction, handleFileAction,
  handlePRAction, handlePRFilterSelectChange, handlePRSearchInput, handleBranchFilterInput,
  initDiffCommentDrag, ACTIVITY_REFRESH_EVENT, type RepoDetail,
  runSecurityScan, toggleGitHook,
} from './views/sourceControl'
import {
  renderSecurityView, bindSecurityProgressListener, resetSecurityProgress,
  toggleRepoSelected, selectAllRepos, selectNoRepos, setSecurityRepoFilter, getSelectedRepoPaths,
} from './views/security'
import { initLogsView, renderLogsView, stopLogsPolling } from './views/logs'
import { openServiceInspector, closeServiceInspector, runServiceAction } from './components/serviceInspector'
import { initCommandPalette, setCommandPaletteIndex, type CommandItem } from './components/commandPalette'
import { initSettingsPanel, openSettingsPanel } from './components/settingsPanel'
import { initClipboardHistoryPanel, openClipboardHistoryPanel } from './components/clipboardHistoryPanel'
import { parsePortConflict, showPortConflictAssistant } from './components/portConflictAssistant'

let services: Service[] = []
let ports: PortUsage[] = []
let jobs: Job[] = []
let dockerStatus = ''
let containerRuntimeStatus: ContainerRuntimeStatus | null = null
// Which engine kind (if any) currently has a Start/Stop/Install RPC in
// flight — disables that row's button so a slow VM start can't be
// double-clicked into two overlapping start attempts.
let engineActionBusy = ''
let activity: ActivitySummary | null = null
let overview: OverviewResult | null = null
let resources: ResourceSnapshot | null = null
let tools: ToolsSnapshot | null = null
let activeRegistry: PackageRegistryKey = 'brew'
let installedBrewPackages: BrewPackages | null = null
let installedLanguagePackages: string[] | null = null
let packageSearchQuery = ''
let brewSearchResults: BrewSearchResult[] | null = null
let languageSearchResults: RegistryPackage[] | null = null
let packageSearching = false
let packageSearchDebounce: number | null = null
let servers: ServerConnection[] = []
let securityReports: SecurityReport[] | null = null
let securityScanning = false
let containerImageScans: Map<string, SecurityReport | 'scanning'> = new Map()
let serverChecks: Map<string, ServerHealth | 'checking'> = new Map()
let serverKeyWarnings: Map<string, string> = new Map()
let serverContainers: Map<string, ServerContainersState> = new Map()
let serverCron: Map<string, ServerCronState> = new Map()
let serverFiles: Map<string, ServerFilesState> = new Map()
let serverTerminal: ServerTerminalState | null = null
let showAddServerForm = false
let editingServer: ServerConnection | null = null
let sshConfigHosts: SSHConfigHost[] | undefined = undefined
let selectedServers: Set<string> = new Set()
let serverBulkRun: ServerBulkRunState | null = null
let serverBulkJobIds: Map<string, string> = new Map()
let serverBulkRunTimer: number | null = null
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


const SUN_ICON = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
const MOON_ICON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'

// Shown icon is what clicking it switches TO (sun while dark = "go light",
// moon while light = "go dark") — same convention as most editors/OSes.
function renderThemeToggleIcon(): void {
  const btn = document.getElementById('theme-toggle-btn')
  if (!btn) return
  const theme = getTheme()
  btn.title = theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${theme === 'dark' ? SUN_ICON : MOON_ICON}</svg>`
}

function toggleTheme(): void {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark')
  renderThemeToggleIcon()
}

function renderApp() {
  applyStoredTheme()
  const app = document.getElementById('app')!
  app.innerHTML = `
    <div class="drag-strip"></div>
    <div id="global-loading-bar"></div>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <img class="mark" src="/appicon.png" alt="Thaloca">
          <div>
            <strong>Thaloca</strong>
            <small>${t('Developer Control Center')}</small>
          </div>
        </div>
        <nav class="nav">
          <button class="nav-btn active" data-view="overview">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>
            </svg>
            <span>${t('Overview')}</span>
          </button>
          <button class="nav-btn" data-view="runtime">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            <span>${t('Runtime')}</span>
          </button>
          <button class="nav-btn" data-view="source">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h4a2 2 0 0 1 2 2v1"/><path d="M9 18h4a2 2 0 0 0 2-2v-1"/>
            </svg>
            <span>${t('Source Control')}</span>
          </button>
          <button class="nav-btn" data-view="activity">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span>${t('Activity')}</span>
          </button>
          <button class="nav-btn" data-view="resources">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/>
              <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>
            </svg>
            <span>${t('Resources')}</span>
          </button>
          <button class="nav-btn" data-view="tools">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <span>${t('Tools')}</span>
          </button>
          <button class="nav-btn" data-view="servers">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="7" rx="1.5"/><rect x="2" y="14" width="20" height="7" rx="1.5"/>
              <line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/>
            </svg>
            <span>${t('Servers')}</span>
          </button>
          <button class="nav-btn" data-view="logs">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>
            </svg>
            <span>${t('Logs')}</span>
          </button>
          <button class="nav-btn" data-view="security">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>${t('Security')}</span>
          </button>
        </nav>
        <div class="local-status">
          <div class="pulse"></div>
          <div>
            <strong>${t('Local Machine')}</strong>
            <small>${t('Connected')}</small>
          </div>
        </div>
      </aside>
      <main class="main">
        <header>
          <div>
            <p class="eyebrow">${t('LOCAL ENVIRONMENT')}</p>
            <h1 id="view-title">${t('Overview')}</h1>
          </div>
          <div class="header-actions">
            <input id="search-input" class="search-input" type="search" placeholder="${t('Search name, port, project...')}">
            <button id="clipboard-btn" class="btn-icon" title="${t('Copy history')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              </svg>
            </button>
            <button id="theme-toggle-btn" class="btn-icon" title="${t('Toggle theme')}"></button>
            <button id="settings-btn" class="btn-icon" title="${t('Settings')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
            <button id="fullscreen-btn" class="btn-icon" title="${t('Toggle fullscreen')}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>
              </svg>
            </button>
            <button id="refresh-btn" class="primary">${t('Refresh')}</button>
          </div>
        </header>
        <div id="error-banner" class="error-banner"></div>

        <section id="overview-view" class="view active"></section>

        <section id="runtime-view" class="view">
          <p class="subview-desc" id="runtime-summary">—</p>
          <div id="runtime-engine-card"></div>
          <nav class="subtabs" id="services-subtabs">
            <button class="subtab active" data-subtab="docker">${t('Containers')} <span class="subtab-count" id="count-docker"></span></button>
            <button class="subtab" data-subtab="processes">${t('Processes')} <span class="subtab-count" id="count-processes"></span></button>
            <button class="subtab" data-subtab="ports">${t('Ports')} <span class="subtab-count" id="count-ports"></span></button>
            <button class="subtab" data-subtab="jobs">${t('Jobs')} <span class="subtab-count" id="count-jobs"></span></button>
          </nav>
          <div id="subview-docker" class="subview active">
            <p class="subview-desc">${t('Containers grouped by Docker Compose project. Click a project to expand it; start or stop one container or the whole project.')}</p>
            <div id="docker-list"></div>
          </div>
          <div id="subview-processes" class="subview">
            <p class="subview-desc">${t('Programs running directly on this Mac (outside Docker) that are listening on a TCP port — dev servers, tools, system services.')}</p>
            <div id="process-list"></div>
          </div>
          <div id="subview-ports" class="subview">
            <p class="subview-desc">${t('Every local TCP port currently in use and which process or container owns it.')}</p>
            <div id="ports-list" class="ports-list"></div>
          </div>
          <div id="subview-jobs" class="subview">
            <p class="subview-desc">${t('Background jobs from Docker workers, cron, launchd, and PM2.')}</p>
            <div id="jobs-list" class="jobs-list"></div>
          </div>
        </section>

        <section id="source-view" class="view">
          <div class="source-toolbar">
            <p class="subview-desc">${t('Work with your repositories like SourceTree: stage, commit, diff, resolve conflicts, browse history, graph and review pull requests.')}</p>
            <div id="gh-connect-area"></div>
          </div>
          <div class="source-layout">
            <div class="source-left">
              <input id="source-filter" class="search-input source-filter" type="search" placeholder="${t('Filter repositories...')}">
              <div id="source-repos" class="source-repos"></div>
            </div>
            <div id="source-detail" class="source-detail"></div>
          </div>
        </section>

        <section id="activity-view" class="view">
          <nav class="subtabs" id="activity-subtabs">
            <button class="subtab active" data-activity-subtab="timeline">${t('Timeline')}</button>
            <button class="subtab" data-activity-subtab="week">${t('This week')}</button>
            <button class="subtab" data-activity-subtab="repos">${t('Repositories')}</button>
          </nav>

          <div id="activity-subview-timeline" class="subview active">
            <nav class="subtabs" id="timeline-filters">
              <button class="subtab active" data-timeline-filter="all">${t('All')}</button>
              <button class="subtab" data-timeline-filter="runtime">${t('Runtime')}</button>
              <button class="subtab" data-timeline-filter="git">Git</button>
            </nav>
            <div id="timeline-list" class="overview-recent"></div>
          </div>

          <div id="activity-subview-week" class="subview">
            <h3 class="section-title">${t('This week across all repositories')}</h3>
            <div class="activity-stats">
              <article><span>${t('Commits (7d)')}</span><strong id="act-commits">—</strong></article>
              <article><span>${t('Active Days')}</span><strong id="act-days">—</strong></article>
              <article><span>${t('Ahead')}</span><strong id="act-ahead">—</strong></article>
              <article><span>${t('Behind')}</span><strong id="act-behind">—</strong></article>
              <article><span>${t('Changed')}</span><strong id="act-changed">—</strong></article>
              <article><span>${t('Staged')}</span><strong id="act-staged">—</strong></article>
              <article><span>${t('Events')}</span><strong id="act-events">—</strong></article>
              <article><span>${t('Quality')}</span><strong id="act-quality">—</strong></article>
            </div>
            <div id="quality-strip" class="quality-strip"></div>
          </div>

          <div id="activity-subview-repos" class="subview">
            <div class="activity-toolbar">
              <div>
                <strong>${t('Tracked Git repositories')}</strong>
                <small id="activity-identity">${t('Loading identity...')}</small>
              </div>
              <label class="switch-row">
                <input id="mine-only-toggle" type="checkbox" checked>
                <span>${t('My commits only')}</span>
              </label>
            </div>
            <div id="activity-note" class="activity-note"></div>
            <div id="repos-list" class="repos-list"></div>
          </div>
        </section>

        <section id="resources-view" class="view">
          <p class="subview-desc">${t('Live machine resources — CPU, memory, swap, disk, and network, plus GPU/battery/thermal where macOS exposes them without elevated privileges. Rescanned every few seconds while this tab is open.')}</p>
          <div id="resources-content"></div>
        </section>

        <section id="tools-view" class="view">
          <nav class="subtabs" id="tools-subtabs">
            <button class="subtab active" data-tools-subtab="detected">${t('Detected Tools')}</button>
            <button class="subtab" data-tools-subtab="packages">${t('Packages')}</button>
            <button class="subtab" data-tools-subtab="utilities">${t('Utilities')}</button>
            <button class="subtab" data-tools-subtab="env">${t('Env Files')}</button>
            <button class="subtab" data-tools-subtab="config-files">${t('Config Files')}</button>
          </nav>
          <div id="subview-tools-detected" class="subview active">
            <p class="subview-desc">${t("Detects installed package-manager/CLI tools and their versions, and flags discovered projects whose own manifest (package.json, go.mod, Cargo.toml, ...) needs a tool that isn't installed. Install/Update run through Homebrew and always ask for confirmation first.")}</p>
            <button id="tools-refresh" class="btn-secondary">${t('Refresh')}</button>
            <div id="tools-content"></div>
          </div>
          <div id="subview-tools-packages" class="subview">
            <p class="subview-desc">${t('Search any Homebrew formula or cask by name and install it, or uninstall anything already on this machine. Always asks for confirmation and shows the exact command first.')}</p>
            <div id="tools-packages-content"></div>
          </div>
          <div id="subview-tools-utilities" class="subview">
            <p class="subview-desc">${t('Small local dev utilities — generators, encoders, format converters. Runs entirely in the app, nothing leaves this machine.')}</p>
            <div id="utilities-content"></div>
          </div>
          <div id="subview-tools-env" class="subview">
            <p class="subview-desc">${t('Which env KEYS each discovered project\'s .env defines — values are hidden by default and only fetched one at a time when you click "Show value", never loaded or cached up front.')}</p>
            <div id="env-files-content"></div>
          </div>
          <div id="subview-tools-config-files" class="subview">
            <div id="config-files-content"></div>
          </div>
        </section>

        <section id="servers-view" class="view">
          <p class="subview-desc">${t('SSH-managed servers you\'ve added by hand (host, user, port, and a path to an existing .pem/key file — Thaloca never reads or stores the key\'s contents). "Check" runs a read-only diagnostic (uptime, memory, disk, Docker). "Containers" lists Docker containers on that server with Start/Stop/Restart/Logs. "Terminal" opens a real interactive SSH session, like opening a terminal to it yourself — there\'s no per-keystroke confirmation, so only run commands you\'d run there directly.')}</p>
          <div id="servers-content"></div>
        </section>

        <section id="logs-view" class="view">
          <p class="subview-desc">${t('Tail Docker containers (local + remote via SSH), Compose projects, and local processes from one place — pick a source on the left, filter lines on the right. Auto-refreshes every 4 seconds while a source is open.')}</p>
          <div id="logs-view-body"></div>
        </section>

        <section id="security-view" class="view">
          <div id="security-content"></div>
        </section>

      </main>
      <aside id="inspector-panel" class="inspector-panel"></aside>
    </div>
  `
  renderThemeToggleIcon()
  bindEvents()
}

function switchView(view: string) {
  document.querySelectorAll('.nav-btn, .view').forEach(el => el.classList.remove('active'))
  document.querySelector(`.nav-btn[data-view="${view}"]`)?.classList.add('active')
  document.getElementById(`${view}-view`)?.classList.add('active')
  const titles: Record<string, string> = { overview: t('Overview'), runtime: t('Runtime'), source: t('Source Control'), activity: t('Activity'), resources: t('Resources'), tools: t('Tools'), servers: t('Servers'), logs: t('Logs'), security: t('Security') }
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
  if ((view === 'tools' || view === 'security') && !tools) {
    void loadTools()
  }

  // The server list is just a local config read — cheap enough to reload
  // on every visit rather than caching it.
  if (view === 'servers') {
    void loadServers()
  }

  // Managed Logs only polls its currently-selected source while its own tab
  // is visible — leaving the tab stops the interval instead of tailing a
  // log for a view nobody is looking at.
  if (view === 'logs') {
    if (servers.length === 0) void loadServers()
    initLogsView({ services, servers })
  } else {
    stopLogsPolling()
  }

}

// Re-translates the app-shell chrome built once in renderApp() (nav labels,
// header, subview descriptions, subtabs) by patching existing elements'
// text/title/placeholder in place — never touching innerHTML/removing
// nodes, so none of bindEvents()'s listeners need rebinding. Runtime's
// subtab buttons carry a live count <span> inside them (see renderApp's
// template), so their label is the button's leading text node rather than
// its whole textContent.
function setSubtabLabel(selector: string, label: string): void {
  const btn = document.querySelector<HTMLElement>(selector)
  if (!btn) return
  if (btn.querySelector('.subtab-count') && btn.firstChild?.nodeType === Node.TEXT_NODE) {
    btn.firstChild.textContent = `${label} `
  } else {
    btn.textContent = label
  }
}

function setText(selector: string, text: string): void {
  const el = document.querySelector(selector)
  if (el) el.textContent = text
}

function applyLocaleToShell(): void {
  setText('.brand small', t('Developer Control Center'))

  const navLabels: Record<string, string> = {
    overview: t('Overview'), runtime: t('Runtime'), source: t('Source Control'), activity: t('Activity'),
    resources: t('Resources'), tools: t('Tools'), servers: t('Servers'), logs: t('Logs'),
    security: t('Security'),
  }
  Object.entries(navLabels).forEach(([view, label]) => setText(`.nav-btn[data-view="${view}"] span`, label))

  setText('.local-status strong', t('Local Machine'))
  setText('.local-status small', t('Connected'))
  setText('.eyebrow', t('LOCAL ENVIRONMENT'))

  const activeView = document.querySelector('.nav-btn.active')?.getAttribute('data-view') || 'overview'
  setText('#view-title', navLabels[activeView] || activeView)

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null
  if (searchInput) searchInput.placeholder = t('Search name, port, project...')
  const clipboardBtn = document.getElementById('clipboard-btn')
  if (clipboardBtn) clipboardBtn.title = t('Copy history')
  renderThemeToggleIcon()
  const settingsBtn = document.getElementById('settings-btn')
  if (settingsBtn) settingsBtn.title = t('Settings')
  const fullscreenBtn = document.getElementById('fullscreen-btn')
  if (fullscreenBtn) fullscreenBtn.title = t('Toggle fullscreen')
  // Leave the Refresh/Tools-Refresh buttons alone if a job is mid-flight —
  // they're showing "Refreshing…" and refreshTools()'s own finally block
  // already restores the localized "Refresh" label when it completes.
  const refreshBtn = document.getElementById('refresh-btn')
  if (refreshBtn) refreshBtn.textContent = t('Refresh')
  const toolsRefreshBtn = document.getElementById('tools-refresh') as HTMLButtonElement | null
  if (toolsRefreshBtn && !toolsRefreshBtn.disabled) toolsRefreshBtn.textContent = t('Refresh')

  setSubtabLabel('#services-subtabs .subtab[data-subtab="docker"]', t('Containers'))
  setSubtabLabel('#services-subtabs .subtab[data-subtab="processes"]', t('Processes'))
  setSubtabLabel('#services-subtabs .subtab[data-subtab="ports"]', t('Ports'))
  setSubtabLabel('#services-subtabs .subtab[data-subtab="jobs"]', t('Jobs'))
  setText('#subview-docker > .subview-desc', t('Containers grouped by Docker Compose project. Click a project to expand it; start or stop one container or the whole project.'))
  setText('#subview-processes > .subview-desc', t('Programs running directly on this Mac (outside Docker) that are listening on a TCP port — dev servers, tools, system services.'))
  setText('#subview-ports > .subview-desc', t('Every local TCP port currently in use and which process or container owns it.'))
  setText('#subview-jobs > .subview-desc', t('Background jobs from Docker workers, cron, launchd, and PM2.'))

  setText('#source-view .subview-desc', t('Work with your repositories like SourceTree: stage, commit, diff, resolve conflicts, browse history, graph and review pull requests.'))
  const sourceFilter = document.getElementById('source-filter') as HTMLInputElement | null
  if (sourceFilter) sourceFilter.placeholder = t('Filter repositories...')

  setText('#activity-subtabs .subtab[data-activity-subtab="timeline"]', t('Timeline'))
  setText('#activity-subtabs .subtab[data-activity-subtab="week"]', t('This week'))
  setText('#activity-subtabs .subtab[data-activity-subtab="repos"]', t('Repositories'))
  setText('#timeline-filters .subtab[data-timeline-filter="all"]', t('All'))
  setText('#timeline-filters .subtab[data-timeline-filter="runtime"]', t('Runtime'))
  setText('#activity-subview-week .section-title', t('This week across all repositories'))
  const statKeys = ['Commits (7d)', 'Active Days', 'Ahead', 'Behind', 'Changed', 'Staged', 'Events', 'Quality']
  document.querySelectorAll('#activity-subview-week .activity-stats article span').forEach((el, i) => {
    if (statKeys[i]) el.textContent = t(statKeys[i])
  })
  setText('.activity-toolbar strong', t('Tracked Git repositories'))
  setText('.activity-toolbar .switch-row span', t('My commits only'))

  setText('#resources-view > .subview-desc', t('Live machine resources — CPU, memory, swap, disk, and network, plus GPU/battery/thermal where macOS exposes them without elevated privileges. Rescanned every few seconds while this tab is open.'))

  setText('#tools-subtabs .subtab[data-tools-subtab="detected"]', t('Detected Tools'))
  setText('#tools-subtabs .subtab[data-tools-subtab="packages"]', t('Packages'))
  setText('#tools-subtabs .subtab[data-tools-subtab="utilities"]', t('Utilities'))
  setText('#tools-subtabs .subtab[data-tools-subtab="env"]', t('Env Files'))
  setText('#tools-subtabs .subtab[data-tools-subtab="config-files"]', t('Config Files'))
  setText('#subview-tools-detected > .subview-desc', t("Detects installed package-manager/CLI tools and their versions, and flags discovered projects whose own manifest (package.json, go.mod, Cargo.toml, ...) needs a tool that isn't installed. Install/Update run through Homebrew and always ask for confirmation first."))
  setText('#subview-tools-packages > .subview-desc', t('Search any Homebrew formula or cask by name and install it, or uninstall anything already on this machine. Always asks for confirmation and shows the exact command first.'))
  setText('#subview-tools-utilities > .subview-desc', t('Small local dev utilities — generators, encoders, format converters. Runs entirely in the app, nothing leaves this machine.'))
  setText('#subview-tools-env > .subview-desc', t('Which env KEYS each discovered project\'s .env defines — values are hidden by default and only fetched one at a time when you click "Show value", never loaded or cached up front.'))

  setText('#servers-view > .subview-desc', t('SSH-managed servers you\'ve added by hand (host, user, port, and a path to an existing .pem/key file — Thaloca never reads or stores the key\'s contents). "Check" runs a read-only diagnostic (uptime, memory, disk, Docker). "Containers" lists Docker containers on that server with Start/Stop/Restart/Logs. "Terminal" opens a real interactive SSH session, like opening a terminal to it yourself — there\'s no per-keystroke confirmation, so only run commands you\'d run there directly.'))
  setText('#logs-view > .subview-desc', t('Tail Docker containers (local + remote via SSH), Compose projects, and local processes from one place — pick a source on the left, filter lines on the right. Auto-refreshes every 4 seconds while a source is open.'))

  // Re-render every view's own dynamic content from already-loaded state
  // (no backend re-fetch) so translated labels/empty-states/status words
  // used inside them switch immediately too.
  renderOverview()
  renderServices()
  renderPorts()
  renderJobs()
  if (activity) {
    renderActivity()
    renderSourceView(activity)
  }
  renderTimeline()
  renderSecurity()
  renderServers()
  renderTools()
  renderResources()
  rebuildCommandIndex()
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
    showError(`${t('Could not open app:')} ${String(error)}`)
    return
  }
  await loadResources()
}

async function handleQuitApp(bundleId: string): Promise<void> {
  if (!(await api.confirmDialog(t('Quit application'), t('Quit this application? Any unsaved work in it will be lost.')))) return
  try {
    await api.quitInstalledApp(bundleId)
  } catch (error) {
    showError(`${t('Could not quit app:')} ${String(error)}`)
    return
  }
  await loadResources()
}

async function handleDeleteApp(path: string, name: string): Promise<void> {
  if (!(await api.confirmDialog(
    t('Delete application'),
    `${t('Delete')} ${name}? ${t('This moves it to the Trash (quitting it first if it\'s running) — nothing is permanently deleted, and you can restore it from the Trash if this was a mistake.')}`,
  ))) return
  try {
    await api.deleteInstalledApp(path)
  } catch (error) {
    showError(`${t('Could not delete app:')} ${String(error)}`)
    return
  }
  await loadResources()
}

async function loadTools(): Promise<void> {
  tools = await api.tools()
  renderTools()
  // The Security tab's "install these tools first" banner (see
  // views/security.ts) depends on this same tools list.
  renderSecurity()
  await loadInstalledPackages()
  renderTools()
}

// Shared by loadTools (initial load) and handleRegistrySwitch (re-fetch for
// whichever registry was just picked) — only one of installedBrewPackages/
// installedLanguagePackages is relevant at a time, matching activeRegistry.
async function loadInstalledPackages(): Promise<void> {
  try {
    if (activeRegistry === 'brew') installedBrewPackages = await api.listBrewPackages()
    else installedLanguagePackages = await api.listLanguagePackages(activeRegistry)
  } catch {
    if (activeRegistry === 'brew') installedBrewPackages = { formulae: [], casks: [] }
    else installedLanguagePackages = []
  }
}

async function refreshTools(button?: HTMLButtonElement): Promise<void> {
  // Re-running the scan with nothing changed on the machine yields the
  // same data as before, which otherwise looks like the button did
  // nothing — this gives immediate, visible feedback that it ran.
  if (button) {
    button.disabled = true
    button.textContent = t('Refreshing…')
  }
  try {
    tools = await api.refreshTools()
    renderTools()
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = t('Refresh')
    }
  }
}

function renderTools(): void {
  renderToolsView({ snapshot: tools, activeAction: toolAction })
  renderPackagesView({
    activeAction: toolAction,
    activeRegistry,
    packageSearchQuery, packageSearching,
    brewSearchResults, languageSearchResults,
    installedBrewPackages, installedLanguagePackages,
  })
  // The output panel's innerHTML (and its scroll position) is recreated on
  // every poll tick while a job runs, which otherwise fights any attempt to
  // scroll it — keep it pinned to the latest output instead, like a
  // live/tail log. The action panel is rendered into both Tools sub-tabs
  // (only one is visible at a time), so scroll whichever exists.
  if (toolAction?.status.running) {
    document.querySelectorAll<HTMLElement>('.tool-action-output').forEach(output => {
      output.scrollTop = output.scrollHeight
    })
  }
}

let toolAction: ToolActionState | null = null
let toolActionTimer: number | null = null

// Shared by handleToolAction (known dev tools) and handlePackageAction (any
// Homebrew package) — both just start a job and need the same "poll every
// 700ms, update the one shared action panel, stop once it's done" loop.
function startToolActionPolling(jobID: string, onDone: () => Promise<void>): void {
  if (toolActionTimer) window.clearInterval(toolActionTimer)
  toolActionTimer = window.setInterval(async () => {
    if (!toolAction) return
    const status = await api.toolActionStatus(jobID)
    toolAction = { ...toolAction, status }
    renderTools()
    if (!status.running) {
      if (toolActionTimer) window.clearInterval(toolActionTimer)
      toolActionTimer = null
      await onDone()
      renderTools()
    }
  }, 700)
}

async function handleToolAction(button: HTMLButtonElement): Promise<void> {
  const tool = button.dataset.toolInstall || button.dataset.toolUpdate || ''
  const action: 'install' | 'update' = button.dataset.toolInstall ? 'install' : 'update'
  const name = button.dataset.toolName || tool
  const command = button.dataset.toolCommand || ''
  if (!tool || !command) return
  if (toolAction?.status.running) {
    showError(`${toolAction.name} ${t('is still running — wait for it to finish first.')}`)
    return
  }

  const verb = action === 'install' ? t('Install') : t('Update')
  if (!(await api.confirmDialog(`${verb} ${name}`, `${t('Run this command now?')}\n\n${command}`))) return

  let jobID: string
  try {
    jobID = await api.runToolAction(tool, action)
  } catch (error) {
    showError(`${t('Could not start')} ${action} ${t('for')} ${name}: ${String(error)}`)
    return
  }

  toolAction = { tool, name, action, command, status: { running: true, output: '', exit_code: 0 } }
  renderTools()
  startToolActionPolling(jobID, async () => {
    // The job just changed reality (installed a tool, bumped a version);
    // pull the fresh state for the grid. The panel itself stays up so the
    // user can still read the output until they close it.
    tools = await api.tools()
  })
}

function packageActionCommand(registry: PackageRegistryKey, name: string, isCask: boolean, action: 'install' | 'uninstall'): string {
  switch (registry) {
    case 'brew': return `brew ${action}${isCask ? ' --cask' : ''} ${name}`
    case 'npm': return action === 'install' ? `npm install -g ${name}` : `npm uninstall -g ${name}`
    case 'pypi': return action === 'install' ? `pip3 install --user ${name}` : `pip3 uninstall -y ${name}`
    case 'cargo': return action === 'install' ? `cargo install ${name}` : `cargo uninstall ${name}`
    case 'composer': return action === 'install' ? `composer global require ${name}` : `composer global remove ${name}`
  }
}

async function handlePackageAction(name: string, isCask: boolean, action: 'install' | 'uninstall'): Promise<void> {
  if (toolAction?.status.running) {
    showError(`${toolAction.name} ${t('is still running — wait for it to finish first.')}`)
    return
  }

  const registry = activeRegistry
  const verb = action === 'install' ? t('Install') : t('Uninstall')
  const command = packageActionCommand(registry, name, isCask, action)
  if (!(await api.confirmDialog(`${verb} ${name}`, `${t('Run this command now?')}\n\n${command}`))) return

  let jobID: string
  try {
    if (registry === 'brew') {
      jobID = action === 'install' ? await api.installBrewPackage(name, isCask) : await api.uninstallBrewPackage(name, isCask)
    } else {
      jobID = action === 'install' ? await api.installLanguagePackage(registry, name) : await api.uninstallLanguagePackage(registry, name)
    }
  } catch (error) {
    showError(`${t('Could not start')} ${action} ${t('for')} ${name}: ${String(error)}`)
    return
  }

  toolAction = { tool: name, name, action, command, status: { running: true, output: '', exit_code: 0 } }
  renderTools()
  startToolActionPolling(jobID, async () => {
    try {
      if (registry === 'brew') installedBrewPackages = await api.listBrewPackages()
      else installedLanguagePackages = await api.listLanguagePackages(registry)
    } catch {
      // Keep the previous list rather than blanking it on a transient error.
    }
  })
}

function handleRegistrySwitch(registry: PackageRegistryKey): void {
  if (registry === activeRegistry) return
  activeRegistry = registry
  packageSearchQuery = ''
  brewSearchResults = null
  languageSearchResults = null
  packageSearching = false
  if (registry === 'brew') installedBrewPackages = null
  else installedLanguagePackages = null
  renderTools()
  void loadInstalledPackages().then(() => renderTools())
}

function handlePackageSearchInput(input: HTMLInputElement): void {
  packageSearchQuery = input.value
  if (packageSearchDebounce) window.clearTimeout(packageSearchDebounce)
  if (!packageSearchQuery.trim()) {
    brewSearchResults = null
    languageSearchResults = null
    packageSearching = false
    renderTools()
    return
  }
  packageSearchDebounce = window.setTimeout(() => { void runPackageSearch() }, 400)
}

async function runPackageSearch(): Promise<void> {
  const query = packageSearchQuery.trim()
  if (!query) return
  packageSearching = true
  renderTools()
  try {
    if (activeRegistry === 'brew') brewSearchResults = await api.searchBrewPackages(query)
    else languageSearchResults = await api.searchLanguagePackages(activeRegistry, query)
  } catch (error) {
    if (activeRegistry === 'brew') brewSearchResults = []
    else languageSearchResults = []
    showError(`${t('Package search failed:')} ${String(error)}`)
  }
  packageSearching = false
  renderTools()
  // Re-rendering replaces the input's own DOM node, so focus/caret need
  // restoring afterwards — same reason handleBranchFilterInput does.
  const el = document.getElementById('package-search-input') as HTMLInputElement | null
  if (el) {
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }
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
  // Auto-check any server that hasn't been checked yet, so CPU/Memory/Disk
  // show real numbers as soon as the tab opens instead of waiting on a
  // manual Check click. Servers already checked (or mid-check) are left
  // alone so switching tabs back and forth doesn't re-SSH repeatedly.
  for (const s of servers) {
    if (!serverChecks.has(s.id)) void handleCheckServer(s.id)
  }
}

function renderServers(): void {
  renderServersView({
    servers, checks: serverChecks, keyWarnings: serverKeyWarnings, containers: serverContainers, cron: serverCron,
    files: serverFiles, terminal: serverTerminal, showAddForm: showAddServerForm, editingServer, sshConfigHosts,
    selectedServers, bulkRun: serverBulkRun,
  })
  // The terminal panel re-renders its innerHTML on every state change like
  // everything else here, but the xterm.js instance itself lives outside
  // that cycle — reattach it into whatever mount point this render just
  // produced so scrollback survives instead of the session being recreated.
  if (serverTerminal) {
    const mount = document.querySelector<HTMLElement>(`[data-server-terminal-mount="${CSS.escape(serverTerminal.serverId)}"]`)
    if (mount) reattachServerTerminal(serverTerminal.serverId, mount)
  }
}

function renderSecurity(): void {
  renderSecurityView({ repos: activity?.repositories || [], reports: securityReports, scanning: securityScanning, tools })
}

async function runAllSecurityScans(): Promise<void> {
  const paths = getSelectedRepoPaths()
  if (!paths.length) return
  resetSecurityProgress()
  securityScanning = true
  renderSecurity()
  try {
    securityReports = await api.runSecurityScanAll(paths)
  } catch (error) {
    showError(String(error))
  }
  securityScanning = false
  renderSecurity()
}

async function handleScanContainerImage(containerId: string, image: string): Promise<void> {
  if (containerImageScans.has(containerId)) {
    containerImageScans.delete(containerId)
    renderServices()
    return
  }
  containerImageScans.set(containerId, 'scanning')
  renderServices()
  try {
    containerImageScans.set(containerId, await api.scanContainerImage(image))
  } catch (error) {
    containerImageScans.delete(containerId)
    showError(String(error))
  }
  renderServices()
}

function toggleAddServerForm(): void {
  showAddServerForm = !showAddServerForm
  editingServer = null
  sshConfigHosts = undefined
  renderServers()
}

function toggleEditServer(id: string): void {
  editingServer = editingServer?.id === id ? null : servers.find(s => s.id === id) || null
  showAddServerForm = false
  renderServers()
}

// Prefills the Add Server fields from a picked ~/.ssh/config entry — a
// convenience fill-in, same as typing the values by hand; nothing is saved
// until the form's own submit button is clicked.
function handleSSHConfigPick(select: HTMLSelectElement): void {
  if (select.value === '') return // the "Choose a host…" placeholder — Number('') is 0, not NaN, so this can't be folded into the lookup below
  const host = sshConfigHosts?.[Number(select.value)]
  if (!host) return
  const form = select.closest('.server-add-form')
  const field = (name: string) => form?.querySelector(`[data-field="${name}"]`) as HTMLInputElement | null
  const nameInput = field('name')
  if (nameInput && !nameInput.value) nameInput.value = host.alias
  const hostInput = field('host')
  if (hostInput) hostInput.value = host.host
  const portInput = field('port')
  if (portInput && host.port) portInput.value = String(host.port)
  const userInput = field('user')
  if (userInput) userInput.value = host.user
  const keyPathInput = field('keyPath')
  if (keyPathInput) keyPathInput.value = host.key_path
  const proxyJumpInput = field('proxyJump')
  if (proxyJumpInput && host.proxy_jump) proxyJumpInput.value = host.proxy_jump
}

function readServerForm(button: HTMLButtonElement): { name: string; host: string; port: number; user: string; keyPath: string; environment: string; proxyJump: string } | null {
  const form = button.closest('.server-add-form')
  const field = (name: string) => (form?.querySelector(`[data-field="${name}"]`) as HTMLInputElement | null)?.value.trim() || ''
  const name = field('name')
  const host = field('host')
  const port = Number(field('port')) || 0
  const user = field('user')
  const keyPath = field('keyPath')
  const environment = (form?.querySelector('[data-field="environment"]') as HTMLSelectElement | null)?.value.trim() || ''
  const proxyJump = field('proxyJump')
  if (!host || !user || !keyPath) {
    showError(t('Host, SSH user, and key path are required.'))
    return null
  }
  return { name, host, port, user, keyPath, environment, proxyJump }
}

async function handleAddServer(button: HTMLButtonElement): Promise<void> {
  const values = readServerForm(button)
  if (!values) return
  let saved: ServerConnection
  try {
    saved = await api.addServer(values.name, values.host, values.port, values.user, values.keyPath, values.environment, values.proxyJump)
  } catch (error) {
    showError(`${t('Could not add server:')} ${String(error)}`)
    return
  }
  showAddServerForm = false
  await loadServers()
  await promptFixKeyPermissionIfNeeded(saved.id)
}

// Lets the Add/Edit Server form verify reachability before Save — reuses
// the same read-only diagnostic as an already-saved server's Check button,
// just against whatever is currently typed into the form.
async function handleCheckServerDraft(button: HTMLButtonElement): Promise<void> {
  const values = readServerForm(button)
  if (!values) return
  const form = button.closest('.server-add-form')
  const resultEl = form?.querySelector('[data-server-check-result]') as HTMLElement | null
  if (resultEl) resultEl.innerHTML = `<span class="muted">${t('Checking…')}</span>`
  button.disabled = true
  try {
    const health = await api.checkServerDraft(values.host, values.port, values.user, values.keyPath, values.proxyJump)
    if (resultEl) {
      resultEl.innerHTML = health.reachable
        ? `<span class="status-badge status-reachable">${t('Reachable')}</span>${health.uptime ? escapeHTML(health.uptime) : ''}`
        : `<span class="status-badge status-down">${t('Unreachable')}</span>${escapeHTML(health.error || t('Connection failed'))}`
    }
  } catch (error) {
    if (resultEl) resultEl.innerHTML = `<span class="status-badge status-down">${t('Failed')}</span>${escapeHTML(String(error))}`
  }
  button.disabled = false
}

async function handleUpdateServer(id: string, button: HTMLButtonElement): Promise<void> {
  const values = readServerForm(button)
  if (!values) return
  let saved: ServerConnection
  try {
    saved = await api.updateServer(id, values.name, values.host, values.port, values.user, values.keyPath, values.environment, values.proxyJump)
  } catch (error) {
    showError(`${t('Could not update server:')} ${String(error)}`)
    return
  }
  editingServer = null
  await loadServers()
  await promptFixKeyPermissionIfNeeded(saved.id)
}

// Proactively checks a just-saved server's key permission instead of
// waiting for the user to click "Check" first — if it's too open, ask right
// away whether Thaloca should chmod it to 0600.
async function promptFixKeyPermissionIfNeeded(id: string): Promise<void> {
  const warning = await api.keyPermissionWarning(id)
  if (!warning) return
  serverKeyWarnings.set(id, warning)
  renderServers()
  if (await api.confirmDialog(t('Fix key permissions'), `${warning}\n\n${t("Thaloca can chmod it to 0600 (owner read/write only) now — only the permission bits change, never the file's contents. Fix it?")}`)) {
    try {
      await api.fixServerKeyPermissions(id)
      serverKeyWarnings.delete(id)
    } catch (error) {
      showError(`${t('Could not fix key permissions:')} ${String(error)}`)
    }
    renderServers()
  }
}

async function handleRemoveServer(id: string): Promise<void> {
  const server = servers.find(s => s.id === id)
  if (!(await api.confirmDialog(t('Remove server'), `${t('Remove')} "${server?.name || id}" ${t('from Thaloca? This only forgets it here — nothing changes on the server itself.')}`))) return
  await api.removeServer(id)
  serverChecks.delete(id)
  serverKeyWarnings.delete(id)
  serverContainers.delete(id)
  serverCron.delete(id)
  serverFiles.delete(id)
  selectedServers.delete(id)
  serverBulkJobIds.delete(id)
  if (serverBulkRun) serverBulkRun = { ...serverBulkRun, jobs: serverBulkRun.jobs.filter(j => j.serverId !== id) }
  const fileTransferTimer = serverFileTransferTimers.get(id)
  if (fileTransferTimer) {
    window.clearInterval(fileTransferTimer)
    serverFileTransferTimers.delete(id)
  }
  if (editingServer?.id === id) editingServer = null
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
  if (!(await api.confirmDialog(t('Fix key permissions'), t('chmod this private key file to 0600 (owner read/write only)? This only changes the file\'s permission bits, never its contents.')))) return
  try {
    await api.fixServerKeyPermissions(id)
  } catch (error) {
    showError(`${t('Could not fix key permissions:')} ${String(error)}`)
    return
  }
  serverKeyWarnings.delete(id)
  renderServers()
}

// Containers, Cron, Files, and Terminal are views onto the same server row
// — only one is shown at a time so opening one doesn't leave another's
// panel stacked underneath it.
function closeOtherServerPanels(id: string, except: 'containers' | 'cron' | 'files' | 'terminal'): void {
  if (except !== 'containers') serverContainers.delete(id)
  if (except !== 'cron') serverCron.delete(id)
  if (except !== 'files') serverFiles.delete(id)
  if (except !== 'terminal' && serverTerminal?.serverId === id) {
    serverTerminal = null
    void closeServerTerminal()
  }
}

async function toggleServerContainers(id: string): Promise<void> {
  if (serverContainers.has(id)) {
    serverContainers.delete(id)
    renderServers()
    return
  }
  closeOtherServerPanels(id, 'containers')
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
  const verbs: Record<string, string> = { start: t('Start'), stop: t('Stop'), restart: t('Restart') }
  if (!(await api.confirmDialog(`${verbs[action]} ${t('container')}`, `${verbs[action]} ${t('this container on the remote server?')}`))) return
  try {
    if (action === 'start') await api.startServerContainer(serverId, containerId)
    else if (action === 'stop') await api.stopServerContainer(serverId, containerId)
    else await api.restartServerContainer(serverId, containerId)
  } catch (error) {
    showError(`${t('Could not')} ${action} ${t('container:')} ${String(error)}`)
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
  serverContainers.set(serverId, { ...current, logs: { containerId, text: t('Loading logs…') } })
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

async function toggleServerCron(id: string): Promise<void> {
  if (serverCron.has(id)) {
    serverCron.delete(id)
    renderServers()
    return
  }
  closeOtherServerPanels(id, 'cron')
  await refreshServerCron(id)
}

async function refreshServerCron(id: string): Promise<void> {
  serverCron.set(id, { status: 'loading', items: [] })
  renderServers()
  try {
    const items = await api.listServerCron(id)
    serverCron.set(id, { status: 'loaded', items })
  } catch (error) {
    serverCron.set(id, { status: 'error', items: [], error: String(error) })
  }
  renderServers()
}

async function handleSetServerCronEnabled(serverId: string, line: number, enabled: boolean): Promise<void> {
  if (!(await api.confirmDialog(enabled ? t('Enable cron job') : t('Disable cron job'), `${enabled ? t('Enable') : t('Disable')} ${t('this cron job on the remote server?')}`))) return
  try {
    await api.setServerCronEnabled(serverId, line, enabled)
  } catch (error) {
    showError(`${t('Could not update cron job:')} ${String(error)}`)
    return
  }
  await refreshServerCron(serverId)
}

async function handleRemoveServerCronLine(serverId: string, line: number): Promise<void> {
  if (!(await api.confirmDialog(t('Remove cron job'), t('Remove this line from the crontab? This cannot be undone.')))) return
  try {
    await api.removeServerCronLine(serverId, line)
  } catch (error) {
    showError(`${t('Could not remove cron job:')} ${String(error)}`)
    return
  }
  await refreshServerCron(serverId)
}

async function toggleServerTerminal(id: string): Promise<void> {
  if (serverTerminal?.serverId === id) {
    serverTerminal = null
    renderServers()
    await closeServerTerminal()
    return
  }

  closeOtherServerPanels(id, 'terminal')
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

async function toggleServerFiles(id: string): Promise<void> {
  if (serverFiles.has(id)) {
    serverFiles.delete(id)
    renderServers()
    return
  }
  closeOtherServerPanels(id, 'files')
  await loadServerFiles(id, '')
}

async function loadServerFiles(id: string, path: string): Promise<void> {
  serverFiles.set(id, { path, status: 'loading', items: [] })
  renderServers()
  try {
    const items = await api.listServerFiles(id, path)
    items.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1))
    serverFiles.set(id, { path, status: 'loaded', items })
  } catch (error) {
    serverFiles.set(id, { path, status: 'error', items: [], error: String(error) })
  }
  renderServers()
}

function joinRemotePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

let serverFileTransferTimers: Map<string, number> = new Map()

// Polls the same ToolActionStatus binding RunToolAction's install/update
// jobs use. On a successful upload, the current directory listing is
// re-fetched so the new file shows up; a download doesn't change anything
// remote, so no refresh is needed for it.
function pollServerFileTransfer(id: string, jobID: string, refreshOnSuccess: boolean): void {
  const existing = serverFileTransferTimers.get(id)
  if (existing) window.clearInterval(existing)
  const timer = window.setInterval(async () => {
    const status = await api.toolActionStatus(jobID)
    if (status.running) return
    window.clearInterval(timer)
    serverFileTransferTimers.delete(id)
    const current = serverFiles.get(id)
    if (!current?.transfer) return
    const failed = status.exit_code !== 0
    serverFiles.set(id, { ...current, transfer: { ...current.transfer, running: false, error: failed ? (status.error || status.output || 'Transfer failed') : undefined } })
    renderServers()
    if (!failed && refreshOnSuccess) void loadServerFiles(id, current.path)
  }, 700)
  serverFileTransferTimers.set(id, timer)
}

async function handleServerFileUpload(id: string): Promise<void> {
  const current = serverFiles.get(id)
  if (!current) return
  const localPath = await api.pickUploadFile()
  if (!localPath) return
  const name = localPath.split('/').pop() || localPath
  const remotePath = joinRemotePath(current.path, name)
  serverFiles.set(id, { ...current, transfer: { kind: 'upload', name, running: true } })
  renderServers()
  try {
    const jobID = await api.uploadServerFile(id, localPath, remotePath)
    pollServerFileTransfer(id, jobID, true)
  } catch (error) {
    const latest = serverFiles.get(id)
    if (latest) serverFiles.set(id, { ...latest, transfer: { kind: 'upload', name, running: false, error: String(error) } })
    renderServers()
  }
}

async function handleServerFileDownload(id: string, name: string): Promise<void> {
  const current = serverFiles.get(id)
  if (!current) return
  const localDir = await api.pickDownloadFolder()
  if (!localDir) return
  const remotePath = joinRemotePath(current.path, name)
  serverFiles.set(id, { ...current, transfer: { kind: 'download', name, running: true } })
  renderServers()
  try {
    const jobID = await api.downloadServerFile(id, remotePath, localDir)
    pollServerFileTransfer(id, jobID, false)
  } catch (error) {
    const latest = serverFiles.get(id)
    if (latest) serverFiles.set(id, { ...latest, transfer: { kind: 'download', name, running: false, error: String(error) } })
    renderServers()
  }
}

function toggleServerBulkRun(): void {
  if (serverBulkRun) {
    cancelServerBulkRun()
    return
  }
  serverBulkRun = { command: '', jobs: [] }
  renderServers()
}

// Bumped by cancelServerBulkRun so a run's in-flight async work (starting
// jobs, polling) can tell it's been cancelled/superseded and stop touching
// shared state instead of racing a later run.
let serverBulkRunGeneration = 0

function cancelServerBulkRun(): void {
  serverBulkRunGeneration++
  serverBulkRun = null
  serverBulkJobIds.clear()
  if (serverBulkRunTimer) {
    window.clearInterval(serverBulkRunTimer)
    serverBulkRunTimer = null
  }
  renderServers()
}

function updateServerBulkRunJob(serverId: string, patch: Partial<ServerBulkRunJobStatus>): void {
  if (!serverBulkRun) return
  serverBulkRun = { ...serverBulkRun, jobs: serverBulkRun.jobs.map(j => (j.serverId === serverId ? { ...j, ...patch } : j)) }
}

async function handleServerBulkRunSubmit(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-server-bulk-run-command]')
  const command = input?.value.trim() || ''
  if (!command) {
    showError(t('Enter a command to run.'))
    return
  }
  const targets = servers.filter(s => selectedServers.has(s.id))
  if (!targets.length) return
  if (!(await api.confirmDialog(t('Run command'), `${t('Run this command on')} ${targets.length} ${t('server(s)?')}\n\n${command}`))) return

  const generation = ++serverBulkRunGeneration
  serverBulkRun = { command, jobs: targets.map(s => ({ serverId: s.id, serverName: s.name, running: true, output: '' })) }
  renderServers()

  await Promise.all(targets.map(async s => {
    try {
      const jobID = await api.runServerCommand(s.id, command)
      if (generation !== serverBulkRunGeneration) return // cancelled while jobs were starting
      serverBulkJobIds.set(s.id, jobID)
    } catch (error) {
      if (generation !== serverBulkRunGeneration) return
      updateServerBulkRunJob(s.id, { running: false, error: String(error) })
    }
  }))
  if (generation !== serverBulkRunGeneration) return
  renderServers()

  if (serverBulkRunTimer) window.clearInterval(serverBulkRunTimer)
  serverBulkRunTimer = window.setInterval(async () => {
    if (generation !== serverBulkRunGeneration) {
      if (serverBulkRunTimer) window.clearInterval(serverBulkRunTimer)
      serverBulkRunTimer = null
      return
    }
    let anyRunning = false
    await Promise.all([...serverBulkJobIds.entries()].map(async ([serverId, jobID]) => {
      const status = await api.toolActionStatus(jobID)
      if (generation !== serverBulkRunGeneration) return
      updateServerBulkRunJob(serverId, { running: status.running, output: status.output, error: status.error || undefined })
      if (status.running) anyRunning = true
    }))
    if (generation !== serverBulkRunGeneration) return
    renderServers()
    if (!anyRunning && serverBulkRunTimer) {
      window.clearInterval(serverBulkRunTimer)
      serverBulkRunTimer = null
    }
  }, 700)
}

function bindEvents() {
  // Wails' default drag handling (see --wails-draggable in style.css) defers
  // the native window-drag call to the next mousemove tick; by the time
  // that async JS->native round trip lands, the original mousedown event
  // can be stale, which either drops the drag entirely or — worse — drags
  // using whatever unrelated mousemove fires next, throwing the window to
  // a wrong position. Firing it immediately on mousedown instead avoids
  // that race for every --wails-draggable region (.brand, .drag-strip,
  // .main > header).
  const wails = (window as unknown as { wails?: { flags?: { deferDragToMouseMove?: boolean } } }).wails
  if (wails?.flags) wails.flags.deferDragToMouseMove = false

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view') || 'overview'))
  })

  document.getElementById('tools-refresh')!.addEventListener('click', event => { void refreshTools(event.currentTarget as HTMLButtonElement) })

  document.getElementById('fullscreen-btn')!.addEventListener('click', () => { void api.toggleFullscreen() })

  document.getElementById('theme-toggle-btn')!.addEventListener('click', toggleTheme)
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
  // components/settingsPanel.ts dispatches this after the language toggle —
  // patches the static shell chrome in place and re-renders every view's
  // dynamic content from already-loaded state (see applyLocaleToShell).
  document.addEventListener(LOCALE_CHANGE_EVENT, applyLocaleToShell)

  // Source Control repo filter (static input, so typing never loses focus)
  document.getElementById('source-filter')?.addEventListener('input', event => {
    setSourceFilter((event.target as HTMLInputElement).value)
  })

  // Security tab's scan-all-repos progress (see desktop/security.go's
  // RunSecurityScanAll) — one persistent app-wide listener, not tied to a
  // specific scan session.
  bindSecurityProgressListener(renderSecurity)

  // Refresh
  document.getElementById('refresh-btn')!.addEventListener('click', loadAll)
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('change', handleDocumentChange)
  document.addEventListener('input', handleBranchFilterInput)
  document.addEventListener('input', event => {
    const target = event.target as HTMLInputElement | null
    // Keeps the typed command from being lost if an unrelated action (e.g.
    // another server row's background health check finishing) triggers a
    // renderServers() while this panel is open — the input itself isn't
    // re-rendered here, just the state it'll be re-created from next time.
    if (target?.dataset.serverBulkRunCommand !== undefined && serverBulkRun) {
      serverBulkRun = { ...serverBulkRun, command: target.value }
    }
    if (target?.id === 'package-search-input') handlePackageSearchInput(target)
    if (target?.id === 'pr-filter-search') handlePRSearchInput(target)
    if (target?.id === 'security-repo-filter') {
      setSecurityRepoFilter(target.value)
      renderSecurity()
      // Re-rendering replaces this input's own DOM node, so focus/caret
      // need restoring afterwards — same reason handleBranchFilterInput does.
      const el = document.getElementById('security-repo-filter') as HTMLInputElement | null
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
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

  // Sub-tabs inside Tools (Detected Tools / Utilities / Env Files / Config
  // Files) — Utilities, Env Files, and Config Files are all lazily
  // initialized on first visit.
  document.querySelectorAll('#tools-subtabs .subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tools-subtabs .subtab, #tools-view .subview').forEach(el => el.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById(`subview-tools-${btn.getAttribute('data-tools-subtab')}`)!.classList.add('active')
      if (btn.getAttribute('data-tools-subtab') === 'utilities') initUtilitiesView()
      if (btn.getAttribute('data-tools-subtab') === 'env') initEnvFilesView()
      if (btn.getAttribute('data-tools-subtab') === 'config-files') initConfigFilesView()
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
  // Splash screen is capped to a short fixed duration rather than tied to
  // however long the real scan takes (Docker/git discovery can run past a
  // couple seconds) — hideSplashScreen() is a no-op once it's already
  // hidden, so whichever of this timer or loadAll()'s own finally block
  // fires first is the one that actually hides it.
  window.setTimeout(hideSplashScreen, 1500)

  // Auto-refresh only runtime data. Git activity is intentionally not polled:
  // it refreshes on app load, manual refresh, or future git event hooks.
  refreshTimer = window.setInterval(loadRuntime, 30_000)
}

async function loadAll() {
  showLoading('docker-list')
  showLoading('ports-list')
  showLoading('repos-list')
  showLoading('jobs-list')
  startGlobalLoading()

  try {
    // Services scan and git activity are independent — run them together
    // so the Activity dashboard is not stuck behind the runtime scan.
    void refreshGHStatus()
    // force=true: this is the header's manual Refresh (and the initial
    // app-load call) — a repo cloned moments ago should show up right
    // away rather than waiting out the 5-minute repo-path cache TTL.
    await Promise.all([loadRuntime(), loadActivity(true)])
  } catch (error) {
    showError(String(error))
  } finally {
    stopGlobalLoading()
    hideSplashScreen()
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

async function loadContainerRuntimeStatus(): Promise<void> {
  try {
    containerRuntimeStatus = await api.getContainerRuntimeStatus()
  } catch {
    containerRuntimeStatus = null
  }
  renderEngineCard()
}

const engineNames: Record<string, string> = { 'docker-desktop': 'Docker Desktop', orbstack: 'OrbStack', colima: 'Colima' }

async function handleEngineStart(kind: string): Promise<void> {
  if (engineActionBusy) return
  engineActionBusy = kind
  renderEngineCard()
  try {
    await api.startContainerRuntime(kind)
  } catch (error) {
    showError(String(error))
  }
  engineActionBusy = ''
  await loadContainerRuntimeStatus()
  await refreshRuntime()
}

async function handleEngineStop(kind: string): Promise<void> {
  if (engineActionBusy) return
  const name = engineNames[kind] || kind
  if (!(await api.confirmDialog(t('Stop container runtime'), `${t('Stop')} ${name}? ${t('Every container running in it will stop too.')}`))) return
  engineActionBusy = kind
  renderEngineCard()
  try {
    await api.stopContainerRuntime(kind)
  } catch (error) {
    showError(String(error))
  }
  engineActionBusy = ''
  await loadContainerRuntimeStatus()
  await refreshRuntime()
}

async function handleEngineInstall(): Promise<void> {
  if (engineActionBusy) return
  if (!(await api.confirmDialog(
    t('Install Colima'),
    t('This runs "brew install colima docker docker-compose docker-buildx" — Homebrew will download and install these on your Mac. This can take several minutes and a few hundred MB of disk space. Continue?'),
  ))) return
  engineActionBusy = 'colima'
  renderEngineCard()
  try {
    await api.installColima()
  } catch (error) {
    showError(String(error))
    engineActionBusy = ''
    renderEngineCard()
    return
  }
  engineActionBusy = ''
  await loadContainerRuntimeStatus()
}

async function doLoadRuntime() {
  // One discovery pass (App.Snapshot) covers services/ports/jobs plus the
  // project grouping and anomaly detection Overview needs — previously
  // these were 4 separate bindings the frontend always called together,
  // with Overview redoing the same service/job discovery the other three
  // had just done.
  const [snapshot] = await Promise.all([api.snapshot(), loadContainerRuntimeStatus()])
  services = normalizeServices(snapshot.services)
  ports = normalizePorts(snapshot.ports)
  jobs = normalizeJobs(snapshot.jobs)
  dockerStatus = snapshot.docker_status || ''
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
    { id: 'view:overview', label: `${t('Go to')} ${t('Overview')}`, kind: 'view', run: () => switchView('overview') },
    { id: 'view:runtime', label: `${t('Go to')} ${t('Runtime')}`, kind: 'view', run: () => switchView('runtime') },
    { id: 'view:source', label: `${t('Go to')} ${t('Source Control')}`, kind: 'view', run: () => switchView('source') },
    { id: 'view:activity', label: `${t('Go to')} ${t('Activity')}`, kind: 'view', run: () => switchView('activity') },
    { id: 'view:resources', label: `${t('Go to')} ${t('Resources')}`, kind: 'view', run: () => switchView('resources') },
    { id: 'view:tools', label: `${t('Go to')} ${t('Tools')}`, kind: 'view', run: () => switchView('tools') },
    { id: 'view:servers', label: `${t('Go to')} ${t('Servers')}`, kind: 'view', run: () => switchView('servers') },
    { id: 'view:logs', label: `${t('Go to')} ${t('Logs')}`, kind: 'view', run: () => switchView('logs') },
    {
      id: 'view:config-files', label: `${t('Go to')} ${t('Config Files')}`, kind: 'view', run: () => {
        switchView('tools')
        document.querySelector<HTMLButtonElement>('#tools-subtabs .subtab[data-tools-subtab="config-files"]')?.click()
      },
    },
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
      label: `${t('Restart')} ${s.name}`,
      hint: 'docker restart',
      kind: 'action',
      run: () => { void runServiceAction(s, 'restart') },
    })),
    ...runningDockerServices.map((s): CommandItem => ({
      id: `action:stop:${s.id}`,
      label: `${t('Stop')} ${s.name}`,
      hint: 'docker stop',
      kind: 'action',
      run: () => { void runServiceAction(s, 'stop') },
    })),
  ]
  const repoItems: CommandItem[] = (activity?.repositories || []).map(r => ({
    id: `repo:${r.path}`,
    label: `${t('Open repo:')} ${r.name}`,
    hint: r.branch,
    kind: 'action',
    run: () => { switchView('source'); void openRepoInSourceControl(r.path) },
  }))
  const serverItems: CommandItem[] = servers.flatMap(s => [
    {
      id: `server:check:${s.id}`,
      label: `${t('Check')} ${s.name}`,
      hint: t('SSH health check'),
      kind: 'action' as const,
      run: () => { switchView('servers'); void handleCheckServer(s.id) },
    },
    {
      id: `server:terminal:${s.id}`,
      label: `${t('Open terminal:')} ${s.name}`,
      hint: 'SSH',
      kind: 'action' as const,
      run: () => { switchView('servers'); void toggleServerTerminal(s.id) },
    },
  ])
  setCommandPaletteIndex([...viewItems, ...serviceItems, ...actionItems, ...repoItems, ...serverItems])
}

async function loadActivity(force = false) {
  activity = normalizeActivity(await api.getActivity(force))
  renderActivity()
  renderSourceView(activity)
  renderOverview()
  renderTimeline()
  renderSecurity()
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
  const button = target?.closest<HTMLButtonElement>('[data-overview-goto-runtime], [data-ignore-repo], [data-track-repo], [data-enable-events], [data-disable-events], [data-stop-pid], [data-stop-container], [data-start-container], [data-restart-container], [data-terminal-container], [data-container-logs], [data-job-logs], [data-project-logs], [data-process-logs], [data-start-project], [data-stop-project], [data-restart-project], [data-down-project], [data-repo-tab], [data-branch-create], [data-branch-switch], [data-branch-merge], [data-branch-delete], [data-file-nav], [data-file-open], [data-file-close], [data-file-maximize], [data-pr-view], [data-pr-back], [data-pr-review], [data-pr-state-tab], [data-pr-new-toggle], [data-pr-new-cancel], [data-pr-new-submit], [data-pr-merge], [data-pr-close], [data-pr-reopen], [data-pr-ready], [data-pr-labels-toggle], [data-pr-labels-cancel], [data-pr-labels-save], [data-pr-reviewers-toggle], [data-pr-reviewers-cancel], [data-pr-reviewers-save], [data-pr-assignees-toggle], [data-pr-assignees-cancel], [data-pr-assignees-save], [data-pr-diff-view], [data-pr-detail-tab], [data-pr-select-file], [data-pr-comment-add], [data-pr-comment-cancel], [data-pr-comment-submit], [data-pr-comment-reply], [data-source-repo], [data-stage], [data-unstage], [data-resolve], [data-commit], [data-diff-file], [data-diff-view-toggle], [data-commit-view], [data-commit-back], [data-commit-file], [data-gh-open], [data-gh-cancel], [data-gh-login], [data-gh-logout], [data-gh-save-client], [data-gh-save-token], [data-gh-cli], [data-sync], [data-history-more], [data-graph-more], [data-branch-more], [data-tool-install], [data-tool-update], [data-tool-action-close], [data-package-install], [data-package-uninstall], [data-package-registry], [data-server-add-toggle], [data-server-add-submit], [data-server-check-draft], [data-server-edit-toggle], [data-server-edit-submit], [data-server-edit-cancel], [data-server-remove], [data-server-check], [data-server-terminal-toggle], [data-server-browse-key], [data-open-external], [data-server-fix-key], [data-server-containers-toggle], [data-server-cron-toggle], [data-server-cron-set-enabled], [data-server-cron-remove], [data-server-files-toggle], [data-server-file-nav], [data-server-file-upload], [data-server-file-download], [data-server-bulk-run-toggle], [data-server-bulk-run-submit], [data-server-bulk-run-cancel], [data-server-ssh-config-load], [data-security-scan], [data-security-hook-toggle], [data-security-scan-all], [data-security-goto-tools], [data-security-select-all], [data-security-select-none], [data-security-change-selection], [data-security-open-file], [data-security-reveal-file], [data-container-scan-image], [data-server-container-start], [data-server-container-stop], [data-server-container-restart], [data-server-container-logs], [data-resource-sort], [data-open-app], [data-quit-app], [data-delete-app], [data-history-window], [data-engine-start], [data-engine-stop], [data-engine-install]')
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

  if (button.dataset.packageInstall) {
    await handlePackageAction(button.dataset.packageInstall, button.dataset.packageCask === '1', 'install')
    return
  }

  if (button.dataset.packageUninstall) {
    await handlePackageAction(button.dataset.packageUninstall, button.dataset.packageCask === '1', 'uninstall')
    return
  }

  if (button.dataset.packageRegistry) {
    handleRegistrySwitch(button.dataset.packageRegistry as PackageRegistryKey)
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

  if (button.dataset.serverCheckDraft !== undefined) {
    await handleCheckServerDraft(button)
    return
  }

  if (button.dataset.serverSshConfigLoad !== undefined) {
    sshConfigHosts = await api.listSSHConfigHosts()
    renderServers()
    return
  }

  if (button.dataset.serverEditToggle) {
    toggleEditServer(button.dataset.serverEditToggle)
    return
  }

  if (button.dataset.serverEditSubmit) {
    await handleUpdateServer(button.dataset.serverEditSubmit, button)
    return
  }

  if (button.dataset.serverEditCancel !== undefined) {
    editingServer = null
    renderServers()
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

  if (button.dataset.serverCronToggle) {
    await toggleServerCron(button.dataset.serverCronToggle)
    return
  }

  if (button.dataset.serverCronSetEnabled) {
    await handleSetServerCronEnabled(button.dataset.serverCronSetEnabled, Number(button.dataset.cronLine), button.dataset.cronEnabled === '1')
    return
  }

  if (button.dataset.serverCronRemove) {
    await handleRemoveServerCronLine(button.dataset.serverCronRemove, Number(button.dataset.cronLine))
    return
  }

  if (button.dataset.serverFilesToggle) {
    await toggleServerFiles(button.dataset.serverFilesToggle)
    return
  }

  if (button.dataset.serverFileNav) {
    await loadServerFiles(button.dataset.serverFileNav, button.dataset.filePath || '')
    return
  }

  if (button.dataset.serverFileUpload) {
    await handleServerFileUpload(button.dataset.serverFileUpload)
    return
  }

  if (button.dataset.serverFileDownload) {
    await handleServerFileDownload(button.dataset.serverFileDownload, button.dataset.fileName || '')
    return
  }

  if (button.dataset.serverBulkRunToggle !== undefined) {
    toggleServerBulkRun()
    return
  }

  if (button.dataset.serverBulkRunSubmit !== undefined) {
    await handleServerBulkRunSubmit()
    return
  }

  if (button.dataset.serverBulkRunCancel !== undefined) {
    cancelServerBulkRun()
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

  if (button.dataset.deleteApp) {
    await handleDeleteApp(button.dataset.deleteApp, button.dataset.deleteAppName || button.dataset.deleteApp)
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

  if (button.dataset.containerScanImage && button.dataset.image) {
    await handleScanContainerImage(button.dataset.containerScanImage, button.dataset.image)
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

  if (button.dataset.overviewGotoRuntime) {
    navigateToProjectInRuntime(button.dataset.overviewGotoRuntime)
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

  if (button.dataset.securityScan && button.dataset.repo) {
    await runSecurityScan(button.dataset.repo)
    return
  }

  if (button.dataset.securityHookToggle && button.dataset.repo) {
    await toggleGitHook(button.dataset.repo, button.dataset.securityHookToggle as 'pre-commit' | 'pre-push')
    return
  }

  if (button.dataset.securityGotoTools) {
    switchView('tools')
    return
  }

  if (button.dataset.securityScanAll) {
    await runAllSecurityScans()
    return
  }

  if (button.dataset.securitySelectAll) {
    selectAllRepos(activity?.repositories || [])
    renderSecurity()
    return
  }

  if (button.dataset.securitySelectNone) {
    selectNoRepos()
    renderSecurity()
    return
  }

  if (button.dataset.securityChangeSelection) {
    securityReports = null
    renderSecurity()
    return
  }

  if (button.dataset.securityOpenFile !== undefined && button.dataset.root !== undefined) {
    try {
      await api.openFileAtLine(button.dataset.root, button.dataset.securityOpenFile, Number(button.dataset.line) || 0)
    } catch (error) {
      showError(String(error))
    }
    return
  }

  if (button.dataset.securityRevealFile !== undefined && button.dataset.root !== undefined) {
    try {
      await api.revealFileInFinder(button.dataset.root, button.dataset.securityRevealFile)
    } catch (error) {
      showError(String(error))
    }
    return
  }

  if (button.dataset.branchCreate || button.dataset.branchSwitch || button.dataset.branchMerge || button.dataset.branchDelete) {
    await handleBranchAction(button)
    return
  }

  if (button.dataset.fileNav !== undefined || button.dataset.fileOpen || button.dataset.fileClose || button.dataset.fileMaximize) {
    await handleFileAction(button)
    return
  }

  if (button.dataset.prView || button.dataset.prBack || button.dataset.prReview
    || button.dataset.prStateTab || button.dataset.prNewToggle || button.dataset.prNewCancel || button.dataset.prNewSubmit
    || button.dataset.prMerge || button.dataset.prClose || button.dataset.prReopen || button.dataset.prReady
    || button.dataset.prLabelsToggle || button.dataset.prLabelsCancel || button.dataset.prLabelsSave
    || button.dataset.prReviewersToggle || button.dataset.prReviewersCancel || button.dataset.prReviewersSave
    || button.dataset.prAssigneesToggle || button.dataset.prAssigneesCancel || button.dataset.prAssigneesSave
    || button.dataset.prDiffView
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
    if (!(await api.confirmDialog(t('Compose down'), `${t('Run docker compose down on')} "${project}"? ${t('This stops AND removes its containers (volumes are kept).')}`))) return
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

  if (button.dataset.engineStart) {
    await handleEngineStart(button.dataset.engineStart)
    return
  }
  if (button.dataset.engineStop) {
    await handleEngineStop(button.dataset.engineStop)
    return
  }
  if (button.dataset.engineInstall) {
    await handleEngineInstall()
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
  jobLogs.set(containerID, t('Loading logs...'))
  renderJobs()
  renderServices()
  try {
    jobLogs.set(containerID, String(await api.containerLogs(containerID) || t('No log output.')))
  } catch (error) {
    jobLogs.set(containerID, `${t('Could not read logs:')} ${String(error)}`)
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
  projectLogs.set(project, t('Loading logs...'))
  renderServices()
  try {
    projectLogs.set(project, String(await api.projectLogs(project) || t('No log output.')))
  } catch (error) {
    projectLogs.set(project, `${t('Could not read logs:')} ${String(error)}`)
  }
  renderServices()
}

async function handleProcessLogs(pid: string) {
  if (processLogs.has(pid)) {
    processLogs.delete(pid)
    renderServices()
    return
  }
  processLogs.set(pid, t('Loading logs...'))
  renderServices()
  try {
    processLogs.set(pid, String(await api.processLogs(Number(pid)) || t('No log output.')))
  } catch (error) {
    processLogs.set(pid, `${t('Could not read logs:')} ${String(error)}`)
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
    if (!(await api.confirmDialog(t('Restart project'), `${t('Restart all')} ${targets.length} ${t('container(s) of')} "${project}"? ${t('Stopped ones are started too.')}`))) return
  } else if (!isStart) {
    if (!(await api.confirmDialog(t('Stop project'), `${t('Stop')} ${targets.length} ${t('running container(s) of')} "${project}"?`))) return
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
    showError(`${failures.length}/${targets.length} ${t('container(s) failed:')} ${String(failures[0].reason)}`)
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
      if (!(await api.confirmDialog(t('Restart container'), t('Restart this container?')))) return
      pendingContainers.set(containerID, 'restarting')
      renderServices()
      await api.restartContainer(containerID)
    } else if (button.dataset.stopContainer) {
      if (!(await api.confirmDialog(t('Stop container'), t('Stop this container?')))) return
      pendingContainers.set(containerID, 'stopping')
      renderServices()
      await api.stopContainer(containerID)
    } else {
      if (!(await api.confirmDialog(t('Stop process'), t('Stop this process?')))) return
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
  if (target?.dataset.securityRepoCheck !== undefined) {
    toggleRepoSelected(target.dataset.securityRepoCheck)
    renderSecurity()
    return
  }
  if (target?.dataset.serverSelect !== undefined) {
    const id = target.dataset.serverSelect
    if (target.checked) selectedServers.add(id)
    else selectedServers.delete(id)
    renderServers()
    return
  }
  if (target?.dataset.serverSelectAll !== undefined) {
    if (target.checked) servers.forEach(s => selectedServers.add(s.id))
    else selectedServers.clear()
    renderServers()
    return
  }
  if (target?.dataset.serverSshConfigPick !== undefined) {
    handleSSHConfigPick(target as unknown as HTMLSelectElement)
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
  renderServicesView({ services, ports, jobs, dockerStatus, searchQuery, healthCache, pendingContainers, jobLogs, projectLogs, processLogs, pendingProjects, imageScans: containerImageScans })
}
function renderEngineCard(): void {
  renderRuntimeEngineCard(containerRuntimeStatus, engineActionBusy)
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

// Overview's per-project "Runtime" button jumps straight to that Docker
// Compose group instead of a single service's inspector. Overview and
// Runtime bucket project-less services under different labels (see
// projectOrUnassigned's header comment in views/overview.ts), so map that
// one case across before expanding/scrolling to the group.
function navigateToProjectInRuntime(project: string): void {
  const runtimeProject = project === 'Unassigned' ? 'standalone containers' : project
  switchView('runtime')
  document.querySelector<HTMLElement>('#services-subtabs .subtab[data-subtab="docker"]')?.click()
  expandProject(runtimeProject)
  renderServices()
  document.querySelector(`[data-toggle-project="${CSS.escape(runtimeProject)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
    ? `${t('Tracking')} ${activity.mine_only ? t('only your commits') : t('all authors')} — ${t('your identities:')} ${identities.join(' · ')}`
    : activity.my_email || activity.my_name
      ? `${t('Tracking')} ${activity.mine_only ? t('only your commits') : t('all authors')} ${t('as')} ${activity.my_name || activity.my_email}`
      : t('No global git identity found; showing all discovered activity')

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
    <article><span>${t('Feat')}</span><strong>${activity.feature_commits}</strong></article>
    <article><span>${t('Fix')}</span><strong>${activity.fix_commits}</strong></article>
    <article><span>${t('Docs')}</span><strong>${activity.docs_commits}</strong></article>
    <article><span>${t('Chore/Test')}</span><strong>${activity.chore_commits}</strong></article>
    <article><span>${t('Merge')}</span><strong>${activity.merge_commits}</strong></article>
  `
}

function renderRepositories(repositories: RepositoryActivity[]) {
  const container = document.getElementById('repos-list')!
  if (repositories.length === 0) {
    container.innerHTML = `<div class="empty">${t('No repositories discovered yet.')}</div>`
    return
  }

  const filtered = repositories.filter(repo => matchesSearch(searchQuery, repo.name, repo.path, repo.branch, repo.identity))
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty compact">${t('No projects match the current search.')}</div>`
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
      <div class="repo-main" data-open-source="${escapeHTML(repo.path)}" title="${t('Show recent activity')}">
        <div class="repo-title">
          <strong>${escapeHTML(repo.name)}</strong>
          <small>${escapeHTML(repo.path)}</small>
        </div>
        <div class="repo-stats">
          ${repo.branch ? `<span>${escapeHTML(repo.branch)}</span>` : ''}
          <span>${repo.commit_count || 0} ${t('commits')}</span>
          ${repo.identity ? `<span class="repo-identity" title="${t('Git identity used for this repository')}">${escapeHTML(repo.identity)}</span>` : ''}
          ${repo.event_tracking ? `<span>${t('events on')}</span>` : ''}
          ${repo.changed_files ? `<span>${repo.changed_files} ${t('changed')}</span>` : ''}
          ${repo.staged_files ? `<span>${repo.staged_files} ${t('staged')}</span>` : ''}
        </div>
        <div class="repo-actions">
          ${repo.event_tracking
            ? `<button class="repo-action" data-disable-events="${escapeHTML(repo.path)}">${t('Disable events')}</button>`
            : `<button class="repo-action" data-enable-events="${escapeHTML(repo.path)}">${t('Enable events')}</button>`}
          ${repo.ignored
            ? `<button class="repo-action" data-track-repo="${escapeHTML(repo.path)}">${t('Track')}</button>`
            : `<button class="repo-action danger" data-ignore-repo="${escapeHTML(repo.path)}">${t('Ignore')}</button>`}
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
        ? `<div class="empty compact">${t('No recent commits or events for this repository.')}</div>`
        : rows.map(r => `
          <div class="repo-inline-row">
            <span class="repo-inline-time">${escapeHTML(formatDate(r.at))}</span>
            <span class="repo-inline-text">${escapeHTML(r.text)}</span>
            <span class="repo-inline-author">${escapeHTML(r.author)}</span>
          </div>`).join('')}
      <button class="repo-action" data-activity-open-source="${escapeHTML(repo.path)}">${t('Open in Source Control')} →</button>
    </div>`
}

// Initialize
document.addEventListener('DOMContentLoaded', renderApp)

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer)
})
