import type { Page } from '@playwright/test'

// Installs a mock window.go.main.App before the page loads, so the real
// frontend code (api.ts -> main.ts / views/*) runs unmodified against
// synthetic data instead of a real Wails/Go backend. Every test in this
// suite calls this first.
export async function installMockApp(page: Page): Promise<void> {
  const now = Date.now()
  await page.addInitScript((now) => {
    const repo1 = '/repo/shop-api'
    // Records mutation calls (stage/unstage/commit/branch ops/...) so tests
    // can assert the right backend call happened with the right arguments,
    // without needing a real git repo.
    ;(window as any).__calls = []
    const record = (name: string, ...args: unknown[]) => (window as any).__calls.push({ name, args })
    ;(window as any).go = {
      main: {
        App: {
          Confirm: async () => true,
          StageFile: async (path: string, file: string) => { record('StageFile', path, file) },
          UnstageFile: async (path: string, file: string) => { record('UnstageFile', path, file) },
          CommitChanges: async (path: string, message: string) => { record('CommitChanges', path, message) },
          CreateBranch: async (path: string, name: string) => { record('CreateBranch', path, name) },
          DeleteBranch: async (path: string, name: string) => { record('DeleteBranch', path, name) },
          SwitchBranch: async (path: string, name: string) => { record('SwitchBranch', path, name) },
          MergeBranch: async (path: string, name: string) => { record('MergeBranch', path, name) },
          Snapshot: async () => ({
            services: [
              { id: 'docker:c1', name: 'shop-api', source: 'docker', ports: [8080], health_url: 'http://localhost:8080/health', status: 'running', pid: 0, container_id: 'c1abcdef0123', repo_path: '', command: '', labels: {}, project: 'shop' },
              { id: 'docker:c2', name: 'shop-worker', source: 'docker', ports: [], health_url: '', status: 'running', pid: 0, container_id: 'c2abcdef0123', repo_path: '', command: '', labels: {}, project: 'shop' },
            ],
            ports: [],
            jobs: [],
            projects: [{
              name: 'shop',
              services: [
                { id: 'docker:c1', name: 'shop-api', source: 'docker', ports: [8080], health_url: '', status: 'running', pid: 0, container_id: 'c1', repo_path: '', command: '', labels: {} },
                { id: 'docker:c2', name: 'shop-worker', source: 'docker', ports: [], health_url: '', status: 'restarting', pid: 0, container_id: 'c2', repo_path: '', command: '', labels: {} },
              ],
              total: 2, healthy: 1, degraded: 1, down: 0,
            }],
            anomalies: [
              { service_id: 'docker:c2', name: 'shop-worker', project: 'shop', kind: 'restart_loop', severity: 'critical', message: 'shop-worker restarted 4 times in the last 10 minutes', since: new Date().toISOString() },
            ],
            scanned_at: new Date().toISOString(),
          }),
          CheckHealth: async () => ({ name: 'shop-api', type: 'http', target: 'http://localhost:8080/health', state: 'healthy', message: 'OK', latency: 12000000, status_code: 200, checked_at: new Date().toISOString() }),
          GetActivity: async () => ({
            since: new Date().toISOString(),
            commits: [{ hash: '3a712fe1234', subject: 'Fix payment retry bug', author: 'Thanh', author_email: 'a@b.com', occurred_at: new Date(now - 60000).toISOString(), repo_name: 'shop-api', repo_path: repo1 }],
            events: [{ occurred_at: new Date(now - 30000).toISOString(), repo_name: 'shop-api', repo_path: repo1, event: 'push', hash: '3a712fe', subject: 'Fix payment retry bug', author: 'Thanh', author_email: 'a@b.com' }],
            repositories: [{ id: 'r1', name: 'shop-api', path: repo1, branch: 'main', commit_count: 3, changed_files: 2, staged_files: 1, ahead: 1, behind: 0, ignored: false, event_tracking: false }],
            commit_count: 1, event_count: 1, active_days: 1, completed_tasks: 0, open_tasks: 0, unpushed: 0,
            branch: 'main', changed_files: 2, staged_files: 1, ahead: 1, behind: 0,
            my_name: 'Thanh', my_email: 'a@b.com', identities: [], mine_only: true, note: '',
            quality_score: 80, fix_commits: 1, feature_commits: 0, docs_commits: 0, chore_commits: 0, merge_commits: 0,
          }),
          RecentEvents: async () => ([
            { id: 'evt1', at: new Date(now - 90000).toISOString(), category: 'action', name: 'container abc', target_type: 'container', target_id: 'abc', kind: 'restarted', message: 'Container abc restarted' },
            { id: 'evt2', at: new Date(now - 120000).toISOString(), category: 'health', name: 'shop-api', target_type: 'service', target_id: 'http://localhost:8080/health', kind: 'health_changed', message: 'shop-api changed from down to healthy' },
          ]),
          GitChanges: async () => ([{ path: 'src/App.tsx', status: 'M', staged: false }]),
          StashList: async () => ([]),
          RepoCommits: async () => ([{ hash: '3a712fe1234', subject: 'Fix payment retry bug', author: 'Thanh', author_email: 'a@b.com', occurred_at: new Date().toISOString(), repo_name: 'shop-api', repo_path: repo1 }]),
          RepoGraph: async () => ([]),
          RepoBranches: async () => ([{ name: 'main', current: true }, { name: 'feature/x', current: false }]),
          RepoFiles: async () => ([{ name: 'src', path: 'src', is_dir: true }]),
          GitHubStatus: async () => ({ configured: false, authenticated: false, message: 'not connected' }),
          ListPullRequests: async () => ([]),
          ProjectLogs: async (project: string) => `shop-api-1  | listening on :8080\nshop-worker-1  | job picked up (project=${project})`,
          ContainerLogs: async (id: string) => `log line for container ${id}`,
          ListServers: async () => ([
            { id: 'srv-1', name: 'API prod', host: '1.2.3.4', port: 22, user: 'ubuntu', key_path: '/keys/prod.pem', environment: 'production' },
          ]),
          AddServer: async (name: string, host: string, port: number, user: string, keyPath: string, environment: string) => {
            record('AddServer', name, host, port, user, keyPath, environment)
            return { id: 'srv-new', name: name || host, host, port, user, key_path: keyPath, environment }
          },
          RemoveServer: async (id: string) => { record('RemoveServer', id) },
          CheckServer: async (id: string) => {
            record('CheckServer', id)
            return {
              reachable: true,
              uptime: '14:32 up 5 days, load averages: 1.20 1.15 1.05',
              memory: '3.2G used / 7.8G total',
              disk: '45G used / 100G total (48%)',
              disk_percent: 48,
              docker_available: true,
              containers: [{ name: 'api', status: 'Up 2 days' }],
              raw: '',
            }
          },
          KeyPermissionWarning: async (id: string) => (id === 'srv-1' ? 'Key file is readable by group/other (mode 0644) — some SSH servers refuse keys like this. Consider fixing to 0600 (owner-only).' : ''),
          FixServerKeyPermissions: async (id: string) => { record('FixServerKeyPermissions', id) },
          ListServerContainers: async (id: string) => {
            record('ListServerContainers', id)
            return [
              { id: 'c1', name: 'api', image: 'myorg/api:latest', status: 'Up 2 days', state: 'running', ports: '0.0.0.0:8080->8080/tcp' },
              { id: 'c2', name: 'worker', image: 'myorg/worker:latest', status: 'Exited (0) 3 hours ago', state: 'exited', ports: '' },
            ]
          },
          ServerContainerLogs: async (id: string, containerId: string) => { record('ServerContainerLogs', id, containerId); return `log line for ${containerId}` },
          StartServerContainer: async (id: string, containerId: string) => { record('StartServerContainer', id, containerId) },
          StopServerContainer: async (id: string, containerId: string) => { record('StopServerContainer', id, containerId) },
          RestartServerContainer: async (id: string, containerId: string) => { record('RestartServerContainer', id, containerId) },
          Resources: async () => ({
            cpu: { user_percent: 20, system_percent: 10, idle_percent: 70 },
            memory: { used_bytes: 4e9, total_bytes: 16e9, used_percent: 25 },
            swap: { used_mb: 0, total_mb: 2048 },
            disks: [],
            network: [],
            processes: [
              { pid: 100, ppid: 1, user: 'thanh', cpu_percent: 12.5, mem_percent: 3.2, rss_bytes: 1e8, command: 'node', path: '/usr/local/bin/node', ports: [3000] },
              { pid: 200, ppid: 1, user: 'thanh', cpu_percent: 1.0, mem_percent: 0.5, rss_bytes: 5e7, command: 'sh', path: '/bin/sh' },
            ],
            gpus: [],
            sampled_at: new Date().toISOString(),
          }),
          InstalledApps: async () => ([
            { name: 'Visual Studio Code', bundle_id: 'com.microsoft.VSCode', version: '1.90.0', path: '/Applications/Visual Studio Code.app', running: true, cpu_percent: 5.5, mem_percent: 2.1 },
            { name: 'Slack', bundle_id: 'com.tinyspeck.slackmacgap', version: '4.36.0', path: '/Applications/Slack.app', running: false, cpu_percent: 0, mem_percent: 0 },
          ]),
          OpenInstalledApp: async (path: string) => { record('OpenInstalledApp', path) },
          QuitInstalledApp: async (bundleId: string) => { record('QuitInstalledApp', bundleId) },
          Tools: async () => ({
            tools: [
              { name: 'Node.js', command: 'node', installed: true, version: 'v20.11.0', path: '/opt/homebrew/bin/node' },
              { name: 'npm', command: 'npm', installed: true, version: '10.2.4', path: '/Users/x/.nvm/versions/node/v20.11.0/bin/npm', managed_by: 'nvm' },
              { name: 'Go', command: 'go', installed: false, install_command: 'brew install go' },
            ],
            projects: [],
            sampled_at: new Date().toISOString(),
          }),
          RunToolAction: async (tool: string, action: string) => { record('RunToolAction', tool, action); return 'job-1' },
          ToolActionStatus: async () => ({ running: false, output: 'done', exit_code: 0 }),
          StopProcess: async (pid: number) => { record('StopProcess', pid) },
        },
      },
    }
  }, now)
}
