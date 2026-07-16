// Type definitions for Wails bindings
export interface Service {
  id: string
  name: string
  source: string
  ports: number[]
  health_url: string
  status: string
  pid: number
  container_id: string
  repo_path: string
  command: string
  project?: string
  labels: Record<string, string>
  engine?: string // docker only — which docker context this container came from
  image?: string // docker only
}

export interface PortUsage {
  port: number
  protocol: string
  address: string
  process: string
  pid: number
  source: string
  container_id?: string
  name?: string
  command?: string
  project?: string
}

export interface HealthStatus {
  name: string
  type: string
  target: string
  state: string
  message: string
  latency: number
  status_code: number
  checked_at: string
}

export interface HealthSamplePoint {
  at: string
  state: string
  latency: number
}

export interface Commit {
  hash: string
  subject: string
  author: string
  author_email: string
  occurred_at: string
  repo_name: string
  repo_path: string
}

export interface GitEvent {
  occurred_at: string
  repo_name: string
  repo_path: string
  event: string
  hash: string
  subject: string
  author: string
  author_email: string
}

export interface RepositoryActivity {
  id: string
  name: string
  path: string
  branch: string
  commit_count: number
  changed_files: number
  staged_files: number
  ahead: number
  behind: number
  ignored: boolean
  event_tracking: boolean
  identity?: string
}

export interface ActivitySummary {
  since: string
  commits: Commit[]
  events: GitEvent[]
  repositories: RepositoryActivity[]
  commit_count: number
  event_count: number
  active_days: number
  completed_tasks: number
  open_tasks: number
  unpushed: number
  branch: string
  changed_files: number
  staged_files: number
  ahead: number
  behind: number
  my_name: string
  my_email: string
  identities: string[]
  mine_only: boolean
  note: string
  quality_score: number
  fix_commits: number
  feature_commits: number
  docs_commits: number
  chore_commits: number
  merge_commits: number
}

export interface RepoBranch {
  name: string
  current: boolean
}

export interface GitHubStatus {
  configured: boolean
  authenticated: boolean
  login?: string
  repo?: string
  message?: string
  source?: string // 'gh' | 'keychain' | 'git-credential'
}

export interface GitHubCLIAccount {
  login: string
  active: boolean
}

// Only key names — values are fetched one at a time, on explicit request
// (see api.getEnvValue), never as part of this list.
export interface EnvFileSummary {
  project_path: string
  project_name: string
  file_name: string
  keys: string[]
}

// One container engine (Docker Desktop, OrbStack, or Colima) as reported
// by GetContainerRuntimeStatus — see desktop/containerRuntime.go.
export interface RuntimeEngineStatus {
  kind: string
  name: string
  download_url?: string
  installed: boolean
  running: boolean
}

export interface ContainerRuntimeStatus {
  engines: RuntimeEngineStatus[]
  multiple_running: boolean
  homebrew_available: boolean
}

// One config file (or, for category "telemetry", one setting read out of a
// config file) shown in the Config Files view. Only "shell" entries can be
// toggleable (and even then, only when their source line is guarded and
// they aren't git-tracked) — see desktop/configFiles.go for why "tool" and
// "telemetry" entries are always read-only.
export interface ConfigFileEntry {
  id: string
  category: 'shell' | 'home' | 'tool' | 'telemetry'
  name: string
  path: string
  source_name?: string
  exists: boolean
  enabled: boolean
  toggleable: boolean
  description: string
  detected_value?: string
}

export interface DeviceCode {
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

export interface GraphCommit {
  hash: string
  parents: string[]
  refs: string[]
  head: boolean
  subject: string
  author: string
  occurred_at: string
}

export interface PullRequest {
  number: number
  title: string
  author: string
  head_ref: string
  base_ref: string
  state: string
  is_draft: boolean
  url: string
  updated_at: string
  review_decision: string
  labels?: string[]
}

// Mirrors desktop/github.go's PullRequestFilter — every field optional,
// matching github.com's own PR list filter bar (state/author/label/search).
export interface PullRequestFilter {
  state?: string // 'open' | 'closed' | 'merged' | 'all'
  author?: string
  label?: string
  search?: string
}

export interface PullRequestCounts {
  open: number
  closed: number
  merged: number
}

export interface PullRequestComment {
  author: string
  body: string
  created_at: string
}

export interface PullRequestDetail {
  number: number
  title: string
  body: string
  author: string
  url: string
  diff: string
  comments: PullRequestComment[]
  state: string
  is_draft: boolean
  mergeable: boolean
  head_ref: string
  head_sha: string
  base_ref: string
  labels?: string[]
  requested_reviewers?: string[]
  assignees?: string[]
}

export interface PullRequestCommit {
  sha: string
  message: string
  author: string
  date: string
}

export interface CheckRun {
  name: string
  status: string // 'queued' | 'in_progress' | 'completed'
  conclusion: string // 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | ''
  url: string
}

export interface PullRequestFile {
  filename: string
  previous_filename?: string
  status: string // 'added' | 'removed' | 'modified' | 'renamed'
  additions: number
  deletions: number
  patch?: string
}

export interface ReviewComment {
  id: number
  path: string
  line: number
  side: string // 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: string
  body: string
  author: string
  created_at: string
  in_reply_to?: number
}

export interface RepoEntry {
  name: string
  dir: boolean
  size: number
}

export interface FileChange {
  path: string
  status: string
  staged: boolean
  conflict: boolean
}

export interface CommitFile {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface Job {
  id: string
  name: string
  source: string
  status: string
  command: string
  schedule?: string
  container_id?: string
  pid?: number
  project?: string
  processes?: string[]
}

// ProjectGroup/Anomaly/OverviewResult mirror the derive-live aggregation
// returned by App.Overview() (desktop/app.go) — nothing here is persisted,
// it is recomputed on every call.
export interface ProjectGroup {
  name: string
  services: Service[]
  total: number
  healthy: number
  degraded: number
  down: number
}

export interface Anomaly {
  service_id: string
  name: string
  project: string
  kind: string // 'restart_loop' | 'degraded'
  severity: string // 'critical' | 'warning'
  message: string
  since: string
}

export interface OverviewResult {
  projects: ProjectGroup[]
  anomalies: Anomaly[]
  scanned_at: string
}

// Mirrors App.Snapshot() (desktop/overview.go) — one discovery pass plus
// everything derived from it, replacing the old Discover/DiscoverPorts/
// DiscoverJobs/Overview bindings the frontend always called together.
export interface Snapshot {
  services: Service[]
  ports: PortUsage[]
  jobs: Job[]
  projects: ProjectGroup[]
  anomalies: Anomaly[]
  scanned_at: string
  // "" when Docker was reached fine (even with zero containers); otherwise
  // a human-readable reason it couldn't be (CLI missing, daemon/OrbStack
  // not running, ...) — see desktop/discovery.go's discoverAll.
  docker_status?: string
}

// Mirrors App.Resources() (desktop/resources.go) — a live read of CPU,
// memory, swap, disk, and network usage, plus best-effort GPU/battery/
// thermal info where macOS exposes it without elevated privileges.
export interface CPUStats {
  user_percent: number
  system_percent: number
  idle_percent: number
}

export interface MemoryStats {
  total_bytes: number
  used_bytes: number
  free_bytes: number
  used_percent: number
}

export interface SwapStats {
  total_mb: number
  used_mb: number
  free_mb: number
}

export interface DiskStats {
  mount_point: string
  total_bytes: number
  used_bytes: number
  free_bytes: number
  used_percent: number
}

export interface NetworkInterfaceStats {
  name: string
  rx_bytes_per_sec: number
  tx_bytes_per_sec: number
  total_rx_bytes: number
  total_tx_bytes: number
}

export interface GPUInfo {
  name: string
  cores?: string
  vram?: string
}

export interface BatteryInfo {
  percent: number
  charging: boolean
  power_source: string
}

export interface ProcessInfo {
  pid: number
  ppid: number
  user: string
  cpu_percent: number
  mem_percent: number
  rss_bytes: number
  command: string
  path: string
  ports?: number[]
  project?: string
}

export interface ResourceSnapshot {
  cpu: CPUStats
  memory: MemoryStats
  swap: SwapStats
  disks: DiskStats[]
  network: NetworkInterfaceStats[]
  processes: ProcessInfo[]
  gpus?: GPUInfo[]
  battery?: BatteryInfo
  thermal?: string
  sampled_at: string
}

export interface ToolInfo {
  name: string
  command: string
  installed: boolean
  version?: string
  path?: string
  install_command?: string
  update_command?: string
  managed_by?: string
  install_blocked_reason?: string
}

export interface ProjectToolRequirement {
  project: string
  path: string
  required: string[]
  missing: string[]
}

export interface ToolsSnapshot {
  tools: ToolInfo[]
  projects: ProjectToolRequirement[]
  sampled_at: string
}

export interface ToolActionStatus {
  running: boolean
  output: string
  exit_code: number
  error?: string
}

export interface BrewSearchResult {
  name: string
  is_cask: boolean
}

export interface BrewPackages {
  formulae: string[]
  casks: string[]
}

// npm/PyPI/crates.io/Packagist — see desktop/languagePackages.go. PyPI has
// no real public search API, so its "search" is really a single
// exact-name existence check (0 or 1 result), not a fuzzy search.
export type LanguageRegistry = 'npm' | 'pypi' | 'cargo' | 'composer'

export interface RegistryPackage {
  name: string
  description?: string
}

export interface ServerConnection {
  id: string
  name: string
  host: string
  port: number
  user: string
  key_path: string
  environment?: string
  proxy_jump?: string
  vpn_enabled?: boolean
  vpn_type?: string
}

export interface VPNFieldDef {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  multiline?: boolean
  span: 'wide' | 'half' | 'narrow'
}

export interface VPNEngineInfo {
  kind: string
  name: string
  installed: boolean
  fields: VPNFieldDef[]
  binary: string
  install_command?: string
}

export interface ServerVPNStatus {
  configured: boolean
  connected: boolean
}

export interface RemoteContainerStatus {
  name: string
  status: string
}

export interface ServerHealth {
  reachable: boolean
  uptime: string
  cpu_percent: number
  memory: string
  mem_percent: number
  disk: string
  disk_percent: number
  docker_available: boolean
  containers: RemoteContainerStatus[]
  raw: string
  error?: string
}

export interface CronJob {
  line: number
  schedule: string
  command: string
  disabled: boolean
  source: string
  env?: string[]
}

// ~/.ssh/config entry, used only to prefill the Add Server form.
export interface SSHConfigHost {
  alias: string
  host: string
  port: number
  user: string
  key_path: string
  proxy_jump?: string
}

export interface RemoteFile {
  name: string
  is_dir: boolean
  size: number
  mod_time: number
}

// Mirrors internal/security's types (Finding/ScannerStatus/Report) and
// desktop/security.go's bindings.
export type SecuritySeverity = 'low' | 'medium' | 'high' | 'critical'

export interface SecurityFinding {
  scanner: string
  tool: string
  severity: SecuritySeverity
  title: string
  detail?: string
  file?: string
  line?: number
  rule_id?: string
}

export interface SecurityScannerStatus {
  scanner: string
  tool?: string
  skipped: boolean
  reason?: string
}

export interface SecurityReport {
  path: string
  scanned_at: string
  findings: SecurityFinding[]
  statuses: SecurityScannerStatus[]
  counts: Partial<Record<SecuritySeverity, number>>
}

export interface GitHookStatus {
  pre_commit: boolean
  pre_push: boolean
}

export interface RemoteContainer {
  id: string
  name: string
  image: string
  status: string
  state: string
  ports: string
}

export interface InstalledApp {
  name: string
  bundle_id: string
  version: string
  path: string
  running: boolean
  cpu_percent: number
  mem_percent: number
  icon?: string
}

export interface NotificationSettings {
  enabled: boolean
  container_stopped: boolean
  health_failed: boolean
  job_errored: boolean
  server_disconnected: boolean
  quiet_hours_start?: string
  quiet_hours_end?: string
}

export interface ConfigBackup {
  servers: ServerConnection[]
  ignored_repos: string[]
  event_repos: string[]
  mine_only: boolean
  pinned_repos: string[]
  notification_settings: NotificationSettings
  exported_at: string
}

export interface ResourceSample {
  at: string
  cpu_percent: number
  mem_percent: number
  disk_percent: number
  net_rx_bytes_per_sec: number
  net_tx_bytes_per_sec: number
  top_process?: string
}

export interface ClipboardEntry {
  id: string
  text: string
  source?: string
  at: string
}

export interface UpdateInfo {
  current_version: string
  latest_version?: string
  available: boolean
  release_url?: string
  error?: string
}

// TimelineEvent mirrors App.RecentEvents() (desktop/app.go) — an in-memory,
// session-only ring buffer of runtime/health/action events. Git commits and
// hook events are not included; the frontend merges those in from
// ActivitySummary (commits/events) separately.
export interface TimelineEvent {
  id: string
  at: string
  category: string // 'runtime' | 'health' | 'action'
  name: string
  project?: string
  target_type: string
  target_id?: string
  kind: string
  message: string
}

export function normalizeActivity(value: Partial<ActivitySummary> | null | undefined): ActivitySummary {
  return {
    since: value?.since || '',
    commits: Array.isArray(value?.commits) ? value.commits : [],
    events: Array.isArray(value?.events) ? value.events : [],
    repositories: Array.isArray(value?.repositories) ? value.repositories : [],
    commit_count: Number(value?.commit_count || 0),
    event_count: Number(value?.event_count || 0),
    active_days: Number(value?.active_days || 0),
    completed_tasks: Number(value?.completed_tasks || 0),
    open_tasks: Number(value?.open_tasks || 0),
    unpushed: Number(value?.unpushed || 0),
    branch: value?.branch || '',
    changed_files: Number(value?.changed_files || 0),
    staged_files: Number(value?.staged_files || 0),
    ahead: Number(value?.ahead || 0),
    behind: Number(value?.behind || 0),
    my_name: value?.my_name || '',
    my_email: value?.my_email || '',
    identities: Array.isArray(value?.identities) ? value.identities : [],
    mine_only: value?.mine_only !== false,
    note: value?.note || '',
    quality_score: Number(value?.quality_score || 0),
    fix_commits: Number(value?.fix_commits || 0),
    feature_commits: Number(value?.feature_commits || 0),
    docs_commits: Number(value?.docs_commits || 0),
    chore_commits: Number(value?.chore_commits || 0),
    merge_commits: Number(value?.merge_commits || 0),
  }
}

function normalizeSnapshot(value: Partial<Snapshot> | null | undefined): Snapshot {
  return {
    services: Array.isArray(value?.services) ? value.services : [],
    ports: Array.isArray(value?.ports) ? value.ports : [],
    jobs: Array.isArray(value?.jobs) ? value.jobs : [],
    projects: Array.isArray(value?.projects) ? value.projects : [],
    anomalies: Array.isArray(value?.anomalies) ? value.anomalies : [],
    scanned_at: value?.scanned_at || '',
    docker_status: value?.docker_status || '',
  }
}

function normalizeResources(value: Partial<ResourceSnapshot> | null | undefined): ResourceSnapshot {
  return {
    cpu: value?.cpu || { user_percent: 0, system_percent: 0, idle_percent: 0 },
    memory: value?.memory || { total_bytes: 0, used_bytes: 0, free_bytes: 0, used_percent: 0 },
    swap: value?.swap || { total_mb: 0, used_mb: 0, free_mb: 0 },
    disks: Array.isArray(value?.disks) ? value.disks : [],
    network: Array.isArray(value?.network) ? value.network : [],
    processes: Array.isArray(value?.processes) ? value.processes : [],
    gpus: Array.isArray(value?.gpus) ? value.gpus : [],
    battery: value?.battery,
    thermal: value?.thermal || '',
    sampled_at: value?.sampled_at || '',
  }
}

function normalizeTools(value: Partial<ToolsSnapshot> | null | undefined): ToolsSnapshot {
  return {
    tools: Array.isArray(value?.tools) ? value.tools : [],
    projects: Array.isArray(value?.projects) ? value.projects : [],
    sampled_at: value?.sampled_at || '',
  }
}

function normalizeToolActionStatus(value: Partial<ToolActionStatus> | null | undefined): ToolActionStatus {
  return {
    running: Boolean(value?.running),
    output: value?.output || '',
    exit_code: Number(value?.exit_code || 0),
    error: value?.error || '',
  }
}

function normalizeBrewPackages(value: Partial<BrewPackages> | null | undefined): BrewPackages {
  return {
    formulae: Array.isArray(value?.formulae) ? value.formulae : [],
    casks: Array.isArray(value?.casks) ? value.casks : [],
  }
}

function normalizeServerHealth(value: Partial<ServerHealth> | null | undefined): ServerHealth {
  return {
    reachable: Boolean(value?.reachable),
    uptime: value?.uptime || '',
    cpu_percent: value?.cpu_percent ?? -1,
    memory: value?.memory || '',
    mem_percent: value?.mem_percent ?? -1,
    disk: value?.disk || '',
    disk_percent: value?.disk_percent ?? -1,
    docker_available: Boolean(value?.docker_available),
    containers: Array.isArray(value?.containers) ? value.containers : [],
    raw: value?.raw || '',
    error: value?.error || '',
  }
}

function normalizeServerVPNStatus(value: Partial<ServerVPNStatus> | null | undefined): ServerVPNStatus {
  return {
    configured: Boolean(value?.configured),
    connected: Boolean(value?.connected),
  }
}

function normalizeRemoteContainers(value: unknown): RemoteContainer[] {
  return Array.isArray(value) ? value : []
}

function normalizeCronJobs(value: unknown): CronJob[] {
  return Array.isArray(value) ? value : []
}

function normalizeSSHConfigHosts(value: unknown): SSHConfigHost[] {
  return Array.isArray(value) ? value : []
}

function normalizeRemoteFiles(value: unknown): RemoteFile[] {
  return Array.isArray(value) ? value : []
}

function normalizeSecurityReport(value: Partial<SecurityReport> | null | undefined): SecurityReport {
  return {
    path: value?.path || '',
    scanned_at: value?.scanned_at || '',
    findings: Array.isArray(value?.findings) ? value.findings : [],
    statuses: Array.isArray(value?.statuses) ? value.statuses : [],
    counts: value?.counts || {},
  }
}

export function normalizeServerList(value: unknown): ServerConnection[] {
  return Array.isArray(value) ? value : []
}

export function normalizeServices(value: unknown): Service[] {
  return Array.isArray(value) ? value : []
}

export function normalizeJobs(value: unknown): Job[] {
  return Array.isArray(value) ? value : []
}

export function normalizePorts(value: unknown): PortUsage[] {
  return Array.isArray(value) ? value : []
}

// Typed shape of the Go App struct's exported methods (desktop/*.go),
// exactly as Wails injects them at window.go.main.App. Partial<> because the
// binding doesn't exist yet outside the Wails runtime (plain browser dev,
// or before Wails finishes injecting) — every api.* call below already
// falls back to a browser-safe default via `||` for that case.
interface WailsApp {
  Snapshot(force: boolean): Promise<Partial<Snapshot>>
  Resources(): Promise<Partial<ResourceSnapshot>>
  InstalledApps(): Promise<InstalledApp[]>
  RefreshInstalledApps(): Promise<InstalledApp[]>
  GetNotificationSettings(): Promise<Partial<NotificationSettings>>
  SetNotificationSettings(settings: NotificationSettings): Promise<void>
  ExportConfig(pinnedRepos: string[]): Promise<string>
  ImportConfig(): Promise<Partial<ConfigBackup>>
  ResourceHistory(window: string): Promise<ResourceSample[]>
  RecordClipboardCopy(text: string, source: string): Promise<ClipboardEntry[]>
  ClipboardHistory(): Promise<ClipboardEntry[]>
  DeleteClipboardEntry(id: string): Promise<ClipboardEntry[]>
  ClearClipboardHistory(): Promise<void>
  GetClipboardHistoryEnabled(): Promise<boolean>
  SetClipboardHistoryEnabled(enabled: boolean): Promise<void>
  GetAppVersion(): Promise<string>
  CheckForUpdate(): Promise<Partial<UpdateInfo>>
  OpenInstalledApp(path: string): Promise<void>
  QuitInstalledApp(bundleId: string): Promise<void>
  DeleteInstalledApp(path: string): Promise<void>
  Tools(): Promise<Partial<ToolsSnapshot>>
  RefreshTools(): Promise<Partial<ToolsSnapshot>>
  RunToolAction(tool: string, action: string): Promise<string>
  OpenHomebrewInstallInTerminal(): Promise<void>
  ToolActionStatus(jobID: string): Promise<Partial<ToolActionStatus>>
  SearchBrewPackages(query: string): Promise<BrewSearchResult[]>
  ListBrewPackages(): Promise<Partial<BrewPackages>>
  InstallBrewPackage(name: string, isCask: boolean): Promise<string>
  UninstallBrewPackage(name: string, isCask: boolean): Promise<string>
  SearchLanguagePackages(registry: string, query: string): Promise<RegistryPackage[]>
  ListLanguagePackages(registry: string): Promise<string[]>
  InstallLanguagePackage(registry: string, name: string): Promise<string>
  UninstallLanguagePackage(registry: string, name: string): Promise<string>
  ListServers(): Promise<ServerConnection[]>
  AddServer(name: string, host: string, port: number, user: string, keyPath: string, environment: string, proxyJump: string): Promise<ServerConnection>
  UpdateServer(id: string, name: string, host: string, port: number, user: string, keyPath: string, environment: string, proxyJump: string): Promise<ServerConnection>
  RemoveServer(id: string): Promise<void>
  CheckServer(id: string): Promise<Partial<ServerHealth>>
  CheckServerDraft(host: string, port: number, user: string, keyPath: string, proxyJump: string): Promise<Partial<ServerHealth>>
  ListVPNEngines(): Promise<VPNEngineInfo[]>
  SetServerVPNConfig(serverId: string, engineKind: string, values: Record<string, string>): Promise<void>
  RemoveServerVPNConfig(serverId: string): Promise<void>
  ServerVPNStatus(serverId: string): Promise<Partial<ServerVPNStatus>>
  ConnectServerVPN(serverId: string): Promise<void>
  DisconnectServerVPN(serverId: string): Promise<void>
  KeyPermissionWarning(id: string): Promise<string>
  FixServerKeyPermissions(id: string): Promise<void>
  RunServerCommand(id: string, command: string): Promise<string>
  OpenServerTerminal(serverId: string): Promise<string>
  WriteServerTerminal(sessionId: string, data: string): Promise<void>
  ResizeServerTerminal(sessionId: string, cols: number, rows: number): Promise<void>
  CloseServerTerminal(sessionId: string): Promise<void>
  ListServerContainers(id: string): Promise<RemoteContainer[]>
  ListServerCron(id: string): Promise<CronJob[]>
  SetServerCronEnabled(id: string, line: number, enabled: boolean): Promise<void>
  RemoveServerCronLine(id: string, line: number): Promise<void>
  ListSSHConfigHosts(): Promise<SSHConfigHost[]>
  ListServerFiles(id: string, remotePath: string): Promise<RemoteFile[]>
  UploadServerFile(id: string, localPath: string, remotePath: string): Promise<string>
  DownloadServerFile(id: string, remotePath: string, localDir: string): Promise<string>
  PickUploadFile(): Promise<string>
  PickDownloadFolder(): Promise<string>
  RunSecurityScan(path: string): Promise<Partial<SecurityReport>>
  GetGitHookStatus(repoPath: string): Promise<Partial<GitHookStatus>>
  InstallGitHook(repoPath: string, kind: string): Promise<void>
  UninstallGitHook(repoPath: string, kind: string): Promise<void>
  RunSecurityScanAll(paths: string[]): Promise<Partial<SecurityReport>[]>
  OpenFileAtLine(root: string, file: string, line: number): Promise<void>
  RevealFileInFinder(root: string, file: string): Promise<void>
  OpenPathInFinder(path: string): Promise<void>
  HasVSCode(): Promise<boolean>
  ScanContainerImage(image: string): Promise<Partial<SecurityReport>>
  GetTerminalHistory(serverId: string): Promise<string[]>
  AppendTerminalHistory(serverId: string, command: string): Promise<void>
  ServerContainerLogs(id: string, containerId: string): Promise<string>
  StartServerContainer(id: string, containerId: string): Promise<void>
  StopServerContainer(id: string, containerId: string): Promise<void>
  RestartServerContainer(id: string, containerId: string): Promise<void>
  HealthHistory(url: string): Promise<HealthSamplePoint[]>
  RecentEvents(limit: number): Promise<TimelineEvent[]>
  CheckHealth(url: string): Promise<HealthStatus>
  StopProcess(pid: number): Promise<void>
  StopContainer(id: string): Promise<void>
  StartContainer(id: string): Promise<void>
  GetActivity(force: boolean): Promise<Partial<ActivitySummary>>
  IgnoreRepository(path: string): Promise<Partial<ActivitySummary>>
  TrackRepository(path: string): Promise<Partial<ActivitySummary>>
  SetMineOnly(enabled: boolean): Promise<Partial<ActivitySummary>>
  EnableGitEvents(path: string): Promise<Partial<ActivitySummary>>
  DisableGitEvents(path: string): Promise<Partial<ActivitySummary>>
  Notify(title: string, message: string): Promise<void>
  PickFolder(): Promise<string>
  PickKeyFile(): Promise<string>
  ToggleFullscreen(): Promise<boolean>
  IsFullscreen(): Promise<boolean>
  Confirm(title: string, message: string): Promise<boolean>
  ContainerLogs(id: string): Promise<string>
  ProjectLogs(project: string): Promise<string>
  ProcessLogs(pid: number): Promise<string>
  RepoCommits(path: string, limit: number, skip: number): Promise<Commit[]>
  GitHubSetToken(token: string): Promise<void>
  RepoBranches(path: string): Promise<RepoBranch[]>
  CreateBranch(path: string, name: string): Promise<void>
  DeleteBranch(path: string, name: string): Promise<void>
  SwitchBranch(path: string, name: string): Promise<void>
  MergeBranch(path: string, name: string): Promise<void>
  RepoFiles(path: string, rel: string): Promise<RepoEntry[]>
  RepoFile(path: string, rel: string): Promise<string>
  RestartContainer(id: string): Promise<void>
  ComposeDown(project: string): Promise<void>
  OpenContainerTerminal(id: string): Promise<string>
  ActivateContainerTerminal(sessionId: string): Promise<void>
  WriteContainerTerminal(sessionId: string, data: string): Promise<void>
  ResizeContainerTerminal(sessionId: string, cols: number, rows: number): Promise<void>
  CloseContainerTerminal(sessionId: string): Promise<void>
  GitHubClientID(): Promise<string>
  SetGitHubClientID(id: string): Promise<void>
  GitHubDeviceStart(): Promise<DeviceCode>
  GitHubDevicePoll(): Promise<string>
  GitHubLogout(): Promise<void>
  GitHubCLIInstalled(): Promise<boolean>
  InstallAndLoginGitHubCLI(): Promise<void>
  GitHubCLIAccounts(): Promise<GitHubCLIAccount[]>
  SwitchGitHubCLIAccount(login: string): Promise<void>
  RepoGraph(path: string, limit: number): Promise<GraphCommit[]>
  FetchRepo(path: string): Promise<void>
  PullRepo(path: string): Promise<void>
  PushRepo(path: string): Promise<void>
  PushBranch(path: string, branch: string): Promise<void>
  StashSave(path: string): Promise<void>
  StashPop(path: string): Promise<void>
  StashList(path: string): Promise<string[]>
  CommitFiles(path: string, hash: string): Promise<CommitFile[]>
  CommitDiff(path: string, hash: string, file: string): Promise<string>
  GitChanges(path: string): Promise<FileChange[]>
  GitDiff(path: string, file: string, staged: boolean): Promise<string>
  StageFile(path: string, file: string): Promise<void>
  UnstageFile(path: string, file: string): Promise<void>
  CommitChanges(path: string, message: string): Promise<void>
  ResolveConflict(path: string, file: string, strategy: string): Promise<void>
  GitHubStatus(path: string): Promise<GitHubStatus>
  RepoGitHubOwner(path: string): Promise<string>
  ListPullRequests(path: string, filter: PullRequestFilter): Promise<PullRequest[]>
  CountPullRequests(path: string, filter: PullRequestFilter): Promise<PullRequestCounts>
  ListPullRequestAuthors(path: string): Promise<string[]>
  PullRequestDetail(path: string, num: number): Promise<PullRequestDetail>
  ReviewPullRequest(path: string, num: number, action: string, body: string): Promise<void>
  MergePullRequest(path: string, num: number, method: string): Promise<void>
  ClosePullRequest(path: string, num: number): Promise<void>
  ReopenPullRequest(path: string, num: number): Promise<void>
  MarkPullRequestReadyForReview(path: string, num: number): Promise<void>
  RequestReviewers(path: string, num: number, reviewers: string[]): Promise<void>
  RemoveReviewers(path: string, num: number, reviewers: string[]): Promise<void>
  AddAssignees(path: string, num: number, assignees: string[]): Promise<void>
  RemoveAssignees(path: string, num: number, assignees: string[]): Promise<void>
  SetPullRequestLabels(path: string, num: number, labels: string[]): Promise<void>
  ListRepositoryLabels(path: string): Promise<string[]>
  ListRepositoryCollaborators(path: string): Promise<string[]>
  CreatePullRequest(path: string, base: string, head: string, title: string, body: string, draft: boolean): Promise<PullRequest>
  PullRequestCommits(path: string, num: number): Promise<PullRequestCommit[]>
  PullRequestChecks(path: string, num: number): Promise<CheckRun[]>
  PullRequestFiles(path: string, num: number): Promise<PullRequestFile[]>
  ListReviewComments(path: string, num: number): Promise<ReviewComment[]>
  CreateReviewComment(path: string, num: number, commitID: string, filePath: string, line: number, side: string, startLine: number, startSide: string, body: string): Promise<void>
  ReplyToReviewComment(path: string, num: number, commentID: number, body: string): Promise<void>
  ListEnvFiles(): Promise<EnvFileSummary[]>
  GetEnvValue(projectPath: string, fileName: string, key: string): Promise<string>
  GetEnvFileContent(projectPath: string, fileName: string): Promise<string>
  ListConfigFiles(): Promise<ConfigFileEntry[]>
  ToggleConfigFile(path: string): Promise<boolean>
  ToggleTelemetry(): Promise<boolean>
  GetContainerRuntimeStatus(): Promise<ContainerRuntimeStatus>
  StartContainerRuntime(kind: string): Promise<void>
  StopContainerRuntime(kind: string): Promise<void>
  InstallColima(): Promise<void>
}

declare global {
  interface Window {
    go?: { main?: { App?: Partial<WailsApp> } }
  }
}

function wailsApp(): Partial<WailsApp> | undefined {
  return window.go?.main?.App
}

// API bindings
export const api = {
  // Normalize even the real binding's result: Go's zero value for a nil
  // slice serializes as JSON null, not [], so every list field must still
  // be defended against null here, not just in the no-binding fallback path.
  snapshot: (force: boolean): Promise<Snapshot> => {
    const fn = wailsApp()?.Snapshot
    return fn ? fn(force).then(normalizeSnapshot) : Promise.resolve(normalizeSnapshot(null))
  },
  resources: (): Promise<ResourceSnapshot> => {
    const fn = wailsApp()?.Resources
    return fn ? fn().then(normalizeResources) : Promise.resolve(normalizeResources(null))
  },
  installedApps: (): Promise<InstalledApp[]> => wailsApp()?.InstalledApps?.() || Promise.resolve([]),
  getNotificationSettings: (): Promise<NotificationSettings> => {
    const fallback: NotificationSettings = { enabled: true, container_stopped: true, health_failed: true, job_errored: true, server_disconnected: true }
    const fn = wailsApp()?.GetNotificationSettings
    return fn ? fn().then(s => ({ ...fallback, ...s })) : Promise.resolve(fallback)
  },
  setNotificationSettings: (settings: NotificationSettings): Promise<void> => {
    const fn = wailsApp()?.SetNotificationSettings
    return fn ? fn(settings) : Promise.reject(new Error('Wails runtime not available'))
  },
  exportConfig: (pinnedRepos: string[]): Promise<string> => {
    const fn = wailsApp()?.ExportConfig
    return fn ? fn(pinnedRepos) : Promise.reject(new Error('Wails runtime not available'))
  },
  importConfig: (): Promise<Partial<ConfigBackup>> => {
    const fn = wailsApp()?.ImportConfig
    return fn ? fn() : Promise.reject(new Error('Wails runtime not available'))
  },
  resourceHistory: (window: string): Promise<ResourceSample[]> => wailsApp()?.ResourceHistory?.(window) || Promise.resolve([]),
  recordClipboardCopy: (text: string, source: string): Promise<ClipboardEntry[]> => wailsApp()?.RecordClipboardCopy?.(text, source) || Promise.resolve([]),
  clipboardHistory: (): Promise<ClipboardEntry[]> => wailsApp()?.ClipboardHistory?.() || Promise.resolve([]),
  deleteClipboardEntry: (id: string): Promise<ClipboardEntry[]> => wailsApp()?.DeleteClipboardEntry?.(id) || Promise.resolve([]),
  clearClipboardHistory: (): Promise<void> => wailsApp()?.ClearClipboardHistory?.() || Promise.resolve(),
  getClipboardHistoryEnabled: (): Promise<boolean> => wailsApp()?.GetClipboardHistoryEnabled?.() || Promise.resolve(true),
  setClipboardHistoryEnabled: (enabled: boolean): Promise<void> => wailsApp()?.SetClipboardHistoryEnabled?.(enabled) || Promise.resolve(),
  getAppVersion: (): Promise<string> => wailsApp()?.GetAppVersion?.() || Promise.resolve(''),
  checkForUpdate: (): Promise<UpdateInfo> => {
    const fallback: UpdateInfo = { current_version: '', available: false }
    const fn = wailsApp()?.CheckForUpdate
    return fn ? fn().then(i => ({ ...fallback, ...i })) : Promise.resolve(fallback)
  },
  refreshInstalledApps: (): Promise<InstalledApp[]> => wailsApp()?.RefreshInstalledApps?.() || Promise.resolve([]),
  openInstalledApp: (path: string): Promise<void> => {
    const fn = wailsApp()?.OpenInstalledApp
    return fn ? fn(path) : Promise.reject(new Error('Wails runtime not available'))
  },
  quitInstalledApp: (bundleId: string): Promise<void> => {
    const fn = wailsApp()?.QuitInstalledApp
    return fn ? fn(bundleId) : Promise.reject(new Error('Wails runtime not available'))
  },
  deleteInstalledApp: (path: string): Promise<void> => {
    const fn = wailsApp()?.DeleteInstalledApp
    return fn ? fn(path) : Promise.reject(new Error('Wails runtime not available'))
  },
  tools: (): Promise<ToolsSnapshot> => {
    const fn = wailsApp()?.Tools
    return fn ? fn().then(normalizeTools) : Promise.resolve(normalizeTools(null))
  },
  refreshTools: (): Promise<ToolsSnapshot> => {
    const fn = wailsApp()?.RefreshTools
    return fn ? fn().then(normalizeTools) : Promise.resolve(normalizeTools(null))
  },
  runToolAction: (tool: string, action: string): Promise<string> => {
    const fn = wailsApp()?.RunToolAction
    return fn ? fn(tool, action) : Promise.reject(new Error('Wails runtime not available'))
  },
  toolActionStatus: (jobID: string): Promise<ToolActionStatus> => {
    const fn = wailsApp()?.ToolActionStatus
    return fn ? fn(jobID).then(normalizeToolActionStatus) : Promise.resolve(normalizeToolActionStatus(null))
  },
  searchBrewPackages: (query: string): Promise<BrewSearchResult[]> => {
    const fn = wailsApp()?.SearchBrewPackages
    return fn ? fn(query).then(v => (Array.isArray(v) ? v : [])) : Promise.resolve([])
  },
  listBrewPackages: (): Promise<BrewPackages> => {
    const fn = wailsApp()?.ListBrewPackages
    return fn ? fn().then(normalizeBrewPackages) : Promise.resolve(normalizeBrewPackages(null))
  },
  installBrewPackage: (name: string, isCask: boolean): Promise<string> => {
    const fn = wailsApp()?.InstallBrewPackage
    return fn ? fn(name, isCask) : Promise.reject(new Error('Wails runtime not available'))
  },
  uninstallBrewPackage: (name: string, isCask: boolean): Promise<string> => {
    const fn = wailsApp()?.UninstallBrewPackage
    return fn ? fn(name, isCask) : Promise.reject(new Error('Wails runtime not available'))
  },
  searchLanguagePackages: (registry: LanguageRegistry, query: string): Promise<RegistryPackage[]> => {
    const fn = wailsApp()?.SearchLanguagePackages
    return fn ? fn(registry, query).then(v => (Array.isArray(v) ? v : [])) : Promise.resolve([])
  },
  listLanguagePackages: (registry: LanguageRegistry): Promise<string[]> => {
    const fn = wailsApp()?.ListLanguagePackages
    return fn ? fn(registry).then(v => (Array.isArray(v) ? v : [])) : Promise.resolve([])
  },
  installLanguagePackage: (registry: LanguageRegistry, name: string): Promise<string> => {
    const fn = wailsApp()?.InstallLanguagePackage
    return fn ? fn(registry, name) : Promise.reject(new Error('Wails runtime not available'))
  },
  uninstallLanguagePackage: (registry: LanguageRegistry, name: string): Promise<string> => {
    const fn = wailsApp()?.UninstallLanguagePackage
    return fn ? fn(registry, name) : Promise.reject(new Error('Wails runtime not available'))
  },
  listServers: (): Promise<ServerConnection[]> => {
    const fn = wailsApp()?.ListServers
    return fn ? fn().then(normalizeServerList) : Promise.resolve([])
  },
  addServer: (name: string, host: string, port: number, user: string, keyPath: string, environment: string, proxyJump: string): Promise<ServerConnection> => {
    const fn = wailsApp()?.AddServer
    return fn ? fn(name, host, port, user, keyPath, environment, proxyJump) : Promise.reject(new Error('Wails runtime not available'))
  },
  removeServer: (id: string): Promise<void> => {
    const fn = wailsApp()?.RemoveServer
    return fn ? fn(id) : Promise.reject(new Error('Wails runtime not available'))
  },
  updateServer: (id: string, name: string, host: string, port: number, user: string, keyPath: string, environment: string, proxyJump: string): Promise<ServerConnection> => {
    const fn = wailsApp()?.UpdateServer
    return fn ? fn(id, name, host, port, user, keyPath, environment, proxyJump) : Promise.reject(new Error('Wails runtime not available'))
  },
  checkServer: (id: string): Promise<ServerHealth> => {
    const fn = wailsApp()?.CheckServer
    return fn ? fn(id).then(normalizeServerHealth) : Promise.resolve(normalizeServerHealth(null))
  },
  checkServerDraft: (host: string, port: number, user: string, keyPath: string, proxyJump: string): Promise<ServerHealth> => {
    const fn = wailsApp()?.CheckServerDraft
    return fn ? fn(host, port, user, keyPath, proxyJump).then(normalizeServerHealth) : Promise.resolve(normalizeServerHealth(null))
  },
  listVPNEngines: (): Promise<VPNEngineInfo[]> => {
    const fn = wailsApp()?.ListVPNEngines
    return fn ? fn() : Promise.resolve([])
  },
  setServerVPNConfig: (serverId: string, engineKind: string, values: Record<string, string>): Promise<void> => {
    const fn = wailsApp()?.SetServerVPNConfig
    return fn ? fn(serverId, engineKind, values) : Promise.reject(new Error('Wails runtime not available'))
  },
  removeServerVPNConfig: (serverId: string): Promise<void> => {
    const fn = wailsApp()?.RemoveServerVPNConfig
    return fn ? fn(serverId) : Promise.reject(new Error('Wails runtime not available'))
  },
  serverVPNStatus: (serverId: string): Promise<ServerVPNStatus> => {
    const fn = wailsApp()?.ServerVPNStatus
    return fn ? fn(serverId).then(normalizeServerVPNStatus) : Promise.resolve(normalizeServerVPNStatus(null))
  },
  connectServerVPN: (serverId: string): Promise<void> => {
    const fn = wailsApp()?.ConnectServerVPN
    return fn ? fn(serverId) : Promise.reject(new Error('Wails runtime not available'))
  },
  disconnectServerVPN: (serverId: string): Promise<void> => {
    const fn = wailsApp()?.DisconnectServerVPN
    return fn ? fn(serverId) : Promise.reject(new Error('Wails runtime not available'))
  },
  keyPermissionWarning: (id: string): Promise<string> => wailsApp()?.KeyPermissionWarning?.(id) || Promise.resolve(''),
  fixServerKeyPermissions: (id: string): Promise<void> => {
    const fn = wailsApp()?.FixServerKeyPermissions
    return fn ? fn(id) : Promise.reject(new Error('Wails runtime not available'))
  },
  runServerCommand: (id: string, command: string): Promise<string> => {
    const fn = wailsApp()?.RunServerCommand
    return fn ? fn(id, command) : Promise.reject(new Error('Wails runtime not available'))
  },
  listServerContainers: (id: string): Promise<RemoteContainer[]> => {
    const fn = wailsApp()?.ListServerContainers
    return fn ? fn(id).then(normalizeRemoteContainers) : Promise.resolve([])
  },
  listServerCron: (id: string): Promise<CronJob[]> => {
    const fn = wailsApp()?.ListServerCron
    return fn ? fn(id).then(normalizeCronJobs) : Promise.resolve([])
  },
  setServerCronEnabled: (id: string, line: number, enabled: boolean): Promise<void> => {
    const fn = wailsApp()?.SetServerCronEnabled
    return fn ? fn(id, line, enabled) : Promise.reject(new Error('Wails runtime not available'))
  },
  removeServerCronLine: (id: string, line: number): Promise<void> => {
    const fn = wailsApp()?.RemoveServerCronLine
    return fn ? fn(id, line) : Promise.reject(new Error('Wails runtime not available'))
  },
  listSSHConfigHosts: (): Promise<SSHConfigHost[]> => {
    const fn = wailsApp()?.ListSSHConfigHosts
    return fn ? fn().then(normalizeSSHConfigHosts) : Promise.resolve([])
  },
  listServerFiles: (id: string, remotePath: string): Promise<RemoteFile[]> => {
    const fn = wailsApp()?.ListServerFiles
    return fn ? fn(id, remotePath).then(normalizeRemoteFiles) : Promise.resolve([])
  },
  uploadServerFile: (id: string, localPath: string, remotePath: string): Promise<string> => {
    const fn = wailsApp()?.UploadServerFile
    return fn ? fn(id, localPath, remotePath) : Promise.reject(new Error('Wails runtime not available'))
  },
  downloadServerFile: (id: string, remotePath: string, localDir: string): Promise<string> => {
    const fn = wailsApp()?.DownloadServerFile
    return fn ? fn(id, remotePath, localDir) : Promise.reject(new Error('Wails runtime not available'))
  },
  pickUploadFile: (): Promise<string> => wailsApp()?.PickUploadFile?.() || Promise.resolve(''),
  pickDownloadFolder: (): Promise<string> => wailsApp()?.PickDownloadFolder?.() || Promise.resolve(''),
  runSecurityScan: (path: string): Promise<SecurityReport> => {
    const fn = wailsApp()?.RunSecurityScan
    return fn ? fn(path).then(normalizeSecurityReport) : Promise.resolve(normalizeSecurityReport(null))
  },
  getGitHookStatus: (repoPath: string): Promise<GitHookStatus> => {
    const fn = wailsApp()?.GetGitHookStatus
    return fn ? fn(repoPath).then(v => ({ pre_commit: Boolean(v?.pre_commit), pre_push: Boolean(v?.pre_push) })) : Promise.resolve({ pre_commit: false, pre_push: false })
  },
  installGitHook: (repoPath: string, kind: 'pre-commit' | 'pre-push'): Promise<void> => {
    const fn = wailsApp()?.InstallGitHook
    return fn ? fn(repoPath, kind) : Promise.reject(new Error('Wails runtime not available'))
  },
  uninstallGitHook: (repoPath: string, kind: 'pre-commit' | 'pre-push'): Promise<void> => {
    const fn = wailsApp()?.UninstallGitHook
    return fn ? fn(repoPath, kind) : Promise.reject(new Error('Wails runtime not available'))
  },
  runSecurityScanAll: (paths: string[]): Promise<SecurityReport[]> => {
    const fn = wailsApp()?.RunSecurityScanAll
    return fn ? fn(paths).then(reports => (Array.isArray(reports) ? reports : []).map(r => normalizeSecurityReport(r))) : Promise.resolve([])
  },
  openFileAtLine: (root: string, file: string, line: number): Promise<void> => {
    const fn = wailsApp()?.OpenFileAtLine
    return fn ? fn(root, file, line) : Promise.reject(new Error('Wails runtime not available'))
  },
  revealFileInFinder: (root: string, file: string): Promise<void> => {
    const fn = wailsApp()?.RevealFileInFinder
    return fn ? fn(root, file) : Promise.reject(new Error('Wails runtime not available'))
  },
  openPathInFinder: (path: string): Promise<void> => {
    const fn = wailsApp()?.OpenPathInFinder
    return fn ? fn(path) : Promise.reject(new Error('Wails runtime not available'))
  },
  openHomebrewInstallInTerminal: (): Promise<void> => {
    const fn = wailsApp()?.OpenHomebrewInstallInTerminal
    return fn ? fn() : Promise.reject(new Error('Wails runtime not available'))
  },
  hasVSCode: (): Promise<boolean> => wailsApp()?.HasVSCode?.() || Promise.resolve(false),
  scanContainerImage: (image: string): Promise<SecurityReport> => {
    const fn = wailsApp()?.ScanContainerImage
    return fn ? fn(image).then(normalizeSecurityReport) : Promise.reject(new Error('Wails runtime not available'))
  },
  getTerminalHistory: (serverId: string): Promise<string[]> => {
    const fn = wailsApp()?.GetTerminalHistory
    return fn ? fn(serverId).then(v => Array.isArray(v) ? v : []) : Promise.resolve([])
  },
  appendTerminalHistory: (serverId: string, command: string): Promise<void> => {
    const fn = wailsApp()?.AppendTerminalHistory
    return fn ? fn(serverId, command) : Promise.resolve()
  },
  serverContainerLogs: (id: string, containerId: string): Promise<string> => {
    const fn = wailsApp()?.ServerContainerLogs
    return fn ? fn(id, containerId) : Promise.reject(new Error('Wails runtime not available'))
  },
  startServerContainer: (id: string, containerId: string): Promise<void> => {
    const fn = wailsApp()?.StartServerContainer
    return fn ? fn(id, containerId) : Promise.reject(new Error('Wails runtime not available'))
  },
  stopServerContainer: (id: string, containerId: string): Promise<void> => {
    const fn = wailsApp()?.StopServerContainer
    return fn ? fn(id, containerId) : Promise.reject(new Error('Wails runtime not available'))
  },
  restartServerContainer: (id: string, containerId: string): Promise<void> => {
    const fn = wailsApp()?.RestartServerContainer
    return fn ? fn(id, containerId) : Promise.reject(new Error('Wails runtime not available'))
  },
  openServerTerminal: (serverId: string): Promise<string> => {
    const fn = wailsApp()?.OpenServerTerminal
    return fn ? fn(serverId) : Promise.reject(new Error('Wails runtime not available'))
  },
  writeServerTerminal: (sessionId: string, data: string): Promise<void> => {
    const fn = wailsApp()?.WriteServerTerminal
    return fn ? fn(sessionId, data) : Promise.reject(new Error('Wails runtime not available'))
  },
  resizeServerTerminal: (sessionId: string, cols: number, rows: number): Promise<void> => {
    const fn = wailsApp()?.ResizeServerTerminal
    return fn ? fn(sessionId, cols, rows) : Promise.reject(new Error('Wails runtime not available'))
  },
  closeServerTerminal: (sessionId: string): Promise<void> => {
    const fn = wailsApp()?.CloseServerTerminal
    return fn ? fn(sessionId) : Promise.resolve()
  },
  healthHistory: (url: string): Promise<HealthSamplePoint[]> => wailsApp()?.HealthHistory?.(url) || Promise.resolve([]),
  recentEvents: (limit: number): Promise<TimelineEvent[]> => wailsApp()?.RecentEvents?.(limit) || Promise.resolve([]),
  checkHealth: (url: string): Promise<HealthStatus> => wailsApp()?.CheckHealth?.(url) || Promise.resolve({ name: '', type: '', target: url, state: 'unknown', message: 'native not available', latency: 0, status_code: 0, checked_at: '' }),
  stopProcess: (pid: number) => wailsApp()?.StopProcess?.(pid) || Promise.resolve(),
  stopContainer: (id: string) => wailsApp()?.StopContainer?.(id) || Promise.resolve(),
  startContainer: (id: string) => wailsApp()?.StartContainer?.(id) || Promise.resolve(),
  getActivity: (force = false) => wailsApp()?.GetActivity?.(force) || Promise.resolve(normalizeActivity(null)),
  ignoreRepository: (path: string) => wailsApp()?.IgnoreRepository?.(path) || Promise.resolve(normalizeActivity(null)),
  trackRepository: (path: string) => wailsApp()?.TrackRepository?.(path) || Promise.resolve(normalizeActivity(null)),
  setMineOnly: (enabled: boolean) => wailsApp()?.SetMineOnly?.(enabled) || Promise.resolve(normalizeActivity(null)),
  enableGitEvents: (path: string) => wailsApp()?.EnableGitEvents?.(path) || Promise.resolve(normalizeActivity(null)),
  disableGitEvents: (path: string) => wailsApp()?.DisableGitEvents?.(path) || Promise.resolve(normalizeActivity(null)),
  notify: (title: string, message: string) => wailsApp()?.Notify?.(title, message) || Promise.resolve(),
  pickFolder: () => wailsApp()?.PickFolder?.() || Promise.resolve(''),
  pickKeyFile: () => wailsApp()?.PickKeyFile?.() || Promise.resolve(''),
  toggleFullscreen: () => wailsApp()?.ToggleFullscreen?.() || Promise.resolve(false),
  isFullscreen: () => wailsApp()?.IsFullscreen?.() || Promise.resolve(false),
  // window.confirm is a no-op inside WKWebView, so confirmation must go
  // through the native dialog binding; plain confirm is the browser fallback.
  confirmDialog: (title: string, message: string): Promise<boolean> => {
    const native = wailsApp()?.Confirm
    return native ? native(title, message) : Promise.resolve(window.confirm(message))
  },
  containerLogs: (id: string) => wailsApp()?.ContainerLogs?.(id) || Promise.resolve(''),
  projectLogs: (project: string) => wailsApp()?.ProjectLogs?.(project) || Promise.resolve(''),
  processLogs: (pid: number) => wailsApp()?.ProcessLogs?.(pid) || Promise.resolve(''),
  repoCommits: (path: string, limit: number, skip: number): Promise<Commit[]> => wailsApp()?.RepoCommits?.(path, limit, skip) || Promise.resolve([]),
  githubSetToken: (token: string) => wailsApp()?.GitHubSetToken?.(token) || Promise.resolve(),
  repoBranches: (path: string) => wailsApp()?.RepoBranches?.(path) || Promise.resolve([]),
  createBranch: (path: string, name: string) => wailsApp()?.CreateBranch?.(path, name) || Promise.resolve(),
  deleteBranch: (path: string, name: string) => wailsApp()?.DeleteBranch?.(path, name) || Promise.resolve(),
  switchBranch: (path: string, name: string) => wailsApp()?.SwitchBranch?.(path, name) || Promise.resolve(),
  mergeBranch: (path: string, name: string) => wailsApp()?.MergeBranch?.(path, name) || Promise.resolve(),
  repoFiles: (path: string, rel: string) => wailsApp()?.RepoFiles?.(path, rel) || Promise.resolve([]),
  repoFile: (path: string, rel: string) => wailsApp()?.RepoFile?.(path, rel) || Promise.resolve(''),
  restartContainer: (id: string) => wailsApp()?.RestartContainer?.(id) || Promise.resolve(),
  composeDown: (project: string) => wailsApp()?.ComposeDown?.(project) || Promise.resolve(),
  openContainerTerminal: (id: string): Promise<string> => {
    const fn = wailsApp()?.OpenContainerTerminal
    return fn ? fn(id) : Promise.reject(new Error('Wails runtime not available'))
  },
  activateContainerTerminal: (sessionId: string): Promise<void> => {
    const fn = wailsApp()?.ActivateContainerTerminal
    return fn ? fn(sessionId) : Promise.reject(new Error('Wails runtime not available'))
  },
  writeContainerTerminal: (sessionId: string, data: string): Promise<void> => {
    const fn = wailsApp()?.WriteContainerTerminal
    return fn ? fn(sessionId, data) : Promise.reject(new Error('Wails runtime not available'))
  },
  resizeContainerTerminal: (sessionId: string, cols: number, rows: number): Promise<void> => {
    const fn = wailsApp()?.ResizeContainerTerminal
    return fn ? fn(sessionId, cols, rows) : Promise.reject(new Error('Wails runtime not available'))
  },
  closeContainerTerminal: (sessionId: string): Promise<void> => {
    const fn = wailsApp()?.CloseContainerTerminal
    return fn ? fn(sessionId) : Promise.resolve()
  },
  githubClientID: (): Promise<string> => wailsApp()?.GitHubClientID?.() || Promise.resolve(''),
  setGitHubClientID: (id: string) => wailsApp()?.SetGitHubClientID?.(id) || Promise.resolve(),
  githubDeviceStart: (): Promise<DeviceCode> => wailsApp()?.GitHubDeviceStart?.() || Promise.reject('native not available'),
  githubDevicePoll: (): Promise<string> => wailsApp()?.GitHubDevicePoll?.() || Promise.reject('native not available'),
  githubLogout: () => wailsApp()?.GitHubLogout?.() || Promise.resolve(),
  githubCLIInstalled: (): Promise<boolean> => wailsApp()?.GitHubCLIInstalled?.() || Promise.resolve(false),
  connectGitHubCLI: () => wailsApp()?.InstallAndLoginGitHubCLI?.() || Promise.reject('native not available'),
  githubCLIAccounts: (): Promise<GitHubCLIAccount[]> => wailsApp()?.GitHubCLIAccounts?.() || Promise.resolve([]),
  switchGitHubCLIAccount: (login: string) => wailsApp()?.SwitchGitHubCLIAccount?.(login) || Promise.reject('native not available'),
  repoGraph: (path: string, limit: number): Promise<GraphCommit[]> => wailsApp()?.RepoGraph?.(path, limit) || Promise.resolve([]),
  fetchRepo: (path: string) => wailsApp()?.FetchRepo?.(path) || Promise.resolve(),
  pullRepo: (path: string) => wailsApp()?.PullRepo?.(path) || Promise.resolve(),
  pushRepo: (path: string) => wailsApp()?.PushRepo?.(path) || Promise.resolve(),
  pushBranch: (path: string, branch: string) => wailsApp()?.PushBranch?.(path, branch) || Promise.reject('native not available'),
  stashSave: (path: string) => wailsApp()?.StashSave?.(path) || Promise.resolve(),
  stashPop: (path: string) => wailsApp()?.StashPop?.(path) || Promise.resolve(),
  stashList: (path: string): Promise<string[]> => wailsApp()?.StashList?.(path) || Promise.resolve([]),
  commitFiles: (path: string, hash: string): Promise<CommitFile[]> => wailsApp()?.CommitFiles?.(path, hash) || Promise.resolve([]),
  commitDiff: (path: string, hash: string, file: string) => wailsApp()?.CommitDiff?.(path, hash, file) || Promise.resolve(''),
  gitChanges: (path: string): Promise<FileChange[]> => wailsApp()?.GitChanges?.(path) || Promise.resolve([]),
  gitDiff: (path: string, file: string, staged: boolean) => wailsApp()?.GitDiff?.(path, file, staged) || Promise.resolve(''),
  stageFile: (path: string, file: string) => wailsApp()?.StageFile?.(path, file) || Promise.resolve(),
  unstageFile: (path: string, file: string) => wailsApp()?.UnstageFile?.(path, file) || Promise.resolve(),
  commitChanges: (path: string, message: string) => wailsApp()?.CommitChanges?.(path, message) || Promise.resolve(),
  resolveConflict: (path: string, file: string, strategy: string) => wailsApp()?.ResolveConflict?.(path, file, strategy) || Promise.resolve(),
  githubStatus: (path: string): Promise<GitHubStatus> => wailsApp()?.GitHubStatus?.(path) || Promise.resolve({ configured: false, authenticated: false, message: 'native not available' }),
  repoGitHubOwner: (path: string): Promise<string> => wailsApp()?.RepoGitHubOwner?.(path) || Promise.resolve(''),
  listPullRequests: (path: string, filter: PullRequestFilter): Promise<PullRequest[]> => wailsApp()?.ListPullRequests?.(path, filter) || Promise.resolve([]),
  countPullRequests: (path: string, filter: PullRequestFilter): Promise<PullRequestCounts> => wailsApp()?.CountPullRequests?.(path, filter) || Promise.resolve({ open: 0, closed: 0, merged: 0 }),
  listPullRequestAuthors: (path: string): Promise<string[]> => wailsApp()?.ListPullRequestAuthors?.(path) || Promise.resolve([]),
  pullRequestDetail: (path: string, num: number): Promise<PullRequestDetail> => wailsApp()?.PullRequestDetail?.(path, num) || Promise.reject('native not available'),
  reviewPullRequest: (path: string, num: number, action: string, body: string) => wailsApp()?.ReviewPullRequest?.(path, num, action, body) || Promise.resolve(),
  mergePullRequest: (path: string, num: number, method: string) => wailsApp()?.MergePullRequest?.(path, num, method) || Promise.reject('native not available'),
  closePullRequest: (path: string, num: number) => wailsApp()?.ClosePullRequest?.(path, num) || Promise.reject('native not available'),
  reopenPullRequest: (path: string, num: number) => wailsApp()?.ReopenPullRequest?.(path, num) || Promise.reject('native not available'),
  markPullRequestReadyForReview: (path: string, num: number) => wailsApp()?.MarkPullRequestReadyForReview?.(path, num) || Promise.reject('native not available'),
  requestReviewers: (path: string, num: number, reviewers: string[]) => wailsApp()?.RequestReviewers?.(path, num, reviewers) || Promise.reject('native not available'),
  removeReviewers: (path: string, num: number, reviewers: string[]) => wailsApp()?.RemoveReviewers?.(path, num, reviewers) || Promise.reject('native not available'),
  addAssignees: (path: string, num: number, assignees: string[]) => wailsApp()?.AddAssignees?.(path, num, assignees) || Promise.reject('native not available'),
  removeAssignees: (path: string, num: number, assignees: string[]) => wailsApp()?.RemoveAssignees?.(path, num, assignees) || Promise.reject('native not available'),
  setPullRequestLabels: (path: string, num: number, labels: string[]) => wailsApp()?.SetPullRequestLabels?.(path, num, labels) || Promise.reject('native not available'),
  listRepositoryLabels: (path: string): Promise<string[]> => wailsApp()?.ListRepositoryLabels?.(path) || Promise.resolve([]),
  listRepositoryCollaborators: (path: string): Promise<string[]> => wailsApp()?.ListRepositoryCollaborators?.(path) || Promise.resolve([]),
  createPullRequest: (path: string, base: string, head: string, title: string, body: string, draft: boolean): Promise<PullRequest> =>
    wailsApp()?.CreatePullRequest?.(path, base, head, title, body, draft) || Promise.reject('native not available'),
  pullRequestCommits: (path: string, num: number): Promise<PullRequestCommit[]> => wailsApp()?.PullRequestCommits?.(path, num) || Promise.resolve([]),
  pullRequestChecks: (path: string, num: number): Promise<CheckRun[]> => wailsApp()?.PullRequestChecks?.(path, num) || Promise.resolve([]),
  pullRequestFiles: (path: string, num: number): Promise<PullRequestFile[]> => wailsApp()?.PullRequestFiles?.(path, num) || Promise.resolve([]),
  listReviewComments: (path: string, num: number): Promise<ReviewComment[]> => wailsApp()?.ListReviewComments?.(path, num) || Promise.resolve([]),
  createReviewComment: (path: string, num: number, commitID: string, filePath: string, line: number, side: string, startLine: number, startSide: string, body: string) =>
    wailsApp()?.CreateReviewComment?.(path, num, commitID, filePath, line, side, startLine, startSide, body) || Promise.reject('native not available'),
  replyToReviewComment: (path: string, num: number, commentID: number, body: string) =>
    wailsApp()?.ReplyToReviewComment?.(path, num, commentID, body) || Promise.reject('native not available'),
  listEnvFiles: (): Promise<EnvFileSummary[]> => wailsApp()?.ListEnvFiles?.() || Promise.resolve([]),
  getEnvValue: (projectPath: string, fileName: string, key: string): Promise<string> =>
    wailsApp()?.GetEnvValue?.(projectPath, fileName, key) || Promise.reject('native not available'),
  getEnvFileContent: (projectPath: string, fileName: string): Promise<string> =>
    wailsApp()?.GetEnvFileContent?.(projectPath, fileName) || Promise.reject('native not available'),
  listConfigFiles: (): Promise<ConfigFileEntry[]> => wailsApp()?.ListConfigFiles?.() || Promise.resolve([]),
  toggleConfigFile: (path: string): Promise<boolean> =>
    wailsApp()?.ToggleConfigFile?.(path) || Promise.reject('native not available'),
  toggleTelemetry: (): Promise<boolean> => wailsApp()?.ToggleTelemetry?.() || Promise.reject('native not available'),
  getContainerRuntimeStatus: (): Promise<ContainerRuntimeStatus> =>
    wailsApp()?.GetContainerRuntimeStatus?.() || Promise.resolve({ engines: [], multiple_running: false, homebrew_available: false }),
  startContainerRuntime: (kind: string): Promise<void> =>
    wailsApp()?.StartContainerRuntime?.(kind) || Promise.reject('native not available'),
  stopContainerRuntime: (kind: string): Promise<void> =>
    wailsApp()?.StopContainerRuntime?.(kind) || Promise.reject('native not available'),
  installColima: (): Promise<void> => wailsApp()?.InstallColima?.() || Promise.reject('native not available'),
}
