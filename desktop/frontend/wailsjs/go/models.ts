export namespace cron {
	
	export class Job {
	    line: number;
	    schedule: string;
	    command: string;
	    disabled: boolean;
	    source: string;
	    env?: string[];
	
	    static createFrom(source: any = {}) {
	        return new Job(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.schedule = source["schedule"];
	        this.command = source["command"];
	        this.disabled = source["disabled"];
	        this.source = source["source"];
	        this.env = source["env"];
	    }
	}

}

export namespace discovery {
	
	export class Service {
	    id: string;
	    name: string;
	    source: string;
	    ports: number[];
	    health_url: string;
	    status: string;
	    pid: number;
	    container_id: string;
	    repo_path: string;
	    command: string;
	    project?: string;
	    labels?: Record<string, string>;
	    image?: string;
	    engine?: string;
	
	    static createFrom(source: any = {}) {
	        return new Service(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.source = source["source"];
	        this.ports = source["ports"];
	        this.health_url = source["health_url"];
	        this.status = source["status"];
	        this.pid = source["pid"];
	        this.container_id = source["container_id"];
	        this.repo_path = source["repo_path"];
	        this.command = source["command"];
	        this.project = source["project"];
	        this.labels = source["labels"];
	        this.image = source["image"];
	        this.engine = source["engine"];
	    }
	}

}

export namespace main {
	
	export class RepositoryActivity {
	    id: string;
	    name: string;
	    path: string;
	    branch?: string;
	    commit_count: number;
	    changed_files: number;
	    staged_files: number;
	    ahead: number;
	    behind: number;
	    ignored: boolean;
	    event_tracking: boolean;
	    identity?: string;
	
	    static createFrom(source: any = {}) {
	        return new RepositoryActivity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.branch = source["branch"];
	        this.commit_count = source["commit_count"];
	        this.changed_files = source["changed_files"];
	        this.staged_files = source["staged_files"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.ignored = source["ignored"];
	        this.event_tracking = source["event_tracking"];
	        this.identity = source["identity"];
	    }
	}
	export class GitEvent {
	    occurred_at: string;
	    repo_name: string;
	    repo_path: string;
	    event: string;
	    hash: string;
	    subject: string;
	    author: string;
	    author_email: string;
	
	    static createFrom(source: any = {}) {
	        return new GitEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.occurred_at = source["occurred_at"];
	        this.repo_name = source["repo_name"];
	        this.repo_path = source["repo_path"];
	        this.event = source["event"];
	        this.hash = source["hash"];
	        this.subject = source["subject"];
	        this.author = source["author"];
	        this.author_email = source["author_email"];
	    }
	}
	export class Commit {
	    hash: string;
	    subject: string;
	    author: string;
	    author_email: string;
	    occurred_at: string;
	    repo_name: string;
	    repo_path: string;
	
	    static createFrom(source: any = {}) {
	        return new Commit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.subject = source["subject"];
	        this.author = source["author"];
	        this.author_email = source["author_email"];
	        this.occurred_at = source["occurred_at"];
	        this.repo_name = source["repo_name"];
	        this.repo_path = source["repo_path"];
	    }
	}
	export class ActivitySummary {
	    since: string;
	    commits: Commit[];
	    events: GitEvent[];
	    repositories: RepositoryActivity[];
	    commit_count: number;
	    event_count: number;
	    active_days: number;
	    completed_tasks: number;
	    open_tasks: number;
	    unpushed: number;
	    branch?: string;
	    changed_files: number;
	    staged_files: number;
	    ahead: number;
	    behind: number;
	    my_name?: string;
	    my_email?: string;
	    identities?: string[];
	    mine_only: boolean;
	    note?: string;
	    quality_score: number;
	    fix_commits: number;
	    feature_commits: number;
	    docs_commits: number;
	    chore_commits: number;
	    merge_commits: number;
	
	    static createFrom(source: any = {}) {
	        return new ActivitySummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.since = source["since"];
	        this.commits = this.convertValues(source["commits"], Commit);
	        this.events = this.convertValues(source["events"], GitEvent);
	        this.repositories = this.convertValues(source["repositories"], RepositoryActivity);
	        this.commit_count = source["commit_count"];
	        this.event_count = source["event_count"];
	        this.active_days = source["active_days"];
	        this.completed_tasks = source["completed_tasks"];
	        this.open_tasks = source["open_tasks"];
	        this.unpushed = source["unpushed"];
	        this.branch = source["branch"];
	        this.changed_files = source["changed_files"];
	        this.staged_files = source["staged_files"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.my_name = source["my_name"];
	        this.my_email = source["my_email"];
	        this.identities = source["identities"];
	        this.mine_only = source["mine_only"];
	        this.note = source["note"];
	        this.quality_score = source["quality_score"];
	        this.fix_commits = source["fix_commits"];
	        this.feature_commits = source["feature_commits"];
	        this.docs_commits = source["docs_commits"];
	        this.chore_commits = source["chore_commits"];
	        this.merge_commits = source["merge_commits"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Anomaly {
	    service_id: string;
	    name: string;
	    project: string;
	    kind: string;
	    severity: string;
	    message: string;
	    since: string;
	
	    static createFrom(source: any = {}) {
	        return new Anomaly(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.service_id = source["service_id"];
	        this.name = source["name"];
	        this.project = source["project"];
	        this.kind = source["kind"];
	        this.severity = source["severity"];
	        this.message = source["message"];
	        this.since = source["since"];
	    }
	}
	export class BatteryInfo {
	    percent: number;
	    charging: boolean;
	    power_source: string;
	
	    static createFrom(source: any = {}) {
	        return new BatteryInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.percent = source["percent"];
	        this.charging = source["charging"];
	        this.power_source = source["power_source"];
	    }
	}
	export class BrewPackages {
	    formulae: string[];
	    casks: string[];
	
	    static createFrom(source: any = {}) {
	        return new BrewPackages(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.formulae = source["formulae"];
	        this.casks = source["casks"];
	    }
	}
	export class BrewSearchResult {
	    name: string;
	    is_cask: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BrewSearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.is_cask = source["is_cask"];
	    }
	}
	export class CPUStats {
	    user_percent: number;
	    system_percent: number;
	    idle_percent: number;
	
	    static createFrom(source: any = {}) {
	        return new CPUStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user_percent = source["user_percent"];
	        this.system_percent = source["system_percent"];
	        this.idle_percent = source["idle_percent"];
	    }
	}
	export class CheckRun {
	    name: string;
	    status: string;
	    conclusion: string;
	    url: string;
	
	    static createFrom(source: any = {}) {
	        return new CheckRun(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.status = source["status"];
	        this.conclusion = source["conclusion"];
	        this.url = source["url"];
	    }
	}
	export class ClipboardEntry {
	    id: string;
	    text: string;
	    source?: string;
	    at: string;
	
	    static createFrom(source: any = {}) {
	        return new ClipboardEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.text = source["text"];
	        this.source = source["source"];
	        this.at = source["at"];
	    }
	}
	
	export class CommitFile {
	    path: string;
	    status: string;
	    additions: number;
	    deletions: number;
	
	    static createFrom(source: any = {}) {
	        return new CommitFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.status = source["status"];
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	    }
	}
	export class NotificationSettings {
	    enabled: boolean;
	    container_stopped: boolean;
	    health_failed: boolean;
	    job_errored: boolean;
	    server_disconnected: boolean;
	    update_available: boolean;
	    quiet_hours_start?: string;
	    quiet_hours_end?: string;
	
	    static createFrom(source: any = {}) {
	        return new NotificationSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.container_stopped = source["container_stopped"];
	        this.health_failed = source["health_failed"];
	        this.job_errored = source["job_errored"];
	        this.server_disconnected = source["server_disconnected"];
	        this.update_available = source["update_available"];
	        this.quiet_hours_start = source["quiet_hours_start"];
	        this.quiet_hours_end = source["quiet_hours_end"];
	    }
	}
	export class ServerConnection {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    user: string;
	    key_path: string;
	    environment?: string;
	    proxy_jump?: string;
	    vpn_enabled?: boolean;
	    vpn_type?: string;
	
	    static createFrom(source: any = {}) {
	        return new ServerConnection(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.key_path = source["key_path"];
	        this.environment = source["environment"];
	        this.proxy_jump = source["proxy_jump"];
	        this.vpn_enabled = source["vpn_enabled"];
	        this.vpn_type = source["vpn_type"];
	    }
	}
	export class ConfigBackup {
	    servers: ServerConnection[];
	    ignored_repos: string[];
	    event_repos: string[];
	    mine_only: boolean;
	    pinned_repos: string[];
	    notification_settings: NotificationSettings;
	    exported_at: string;
	
	    static createFrom(source: any = {}) {
	        return new ConfigBackup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.servers = this.convertValues(source["servers"], ServerConnection);
	        this.ignored_repos = source["ignored_repos"];
	        this.event_repos = source["event_repos"];
	        this.mine_only = source["mine_only"];
	        this.pinned_repos = source["pinned_repos"];
	        this.notification_settings = this.convertValues(source["notification_settings"], NotificationSettings);
	        this.exported_at = source["exported_at"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConfigFileEntry {
	    id: string;
	    category: string;
	    name: string;
	    path: string;
	    source_name?: string;
	    exists: boolean;
	    enabled: boolean;
	    toggleable: boolean;
	    description: string;
	    detected_value?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConfigFileEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.category = source["category"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.source_name = source["source_name"];
	        this.exists = source["exists"];
	        this.enabled = source["enabled"];
	        this.toggleable = source["toggleable"];
	        this.description = source["description"];
	        this.detected_value = source["detected_value"];
	    }
	}
	export class RuntimeEngineStatus {
	    kind: string;
	    name: string;
	    download_url?: string;
	    installed: boolean;
	    running: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RuntimeEngineStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.name = source["name"];
	        this.download_url = source["download_url"];
	        this.installed = source["installed"];
	        this.running = source["running"];
	    }
	}
	export class ContainerRuntimeStatus {
	    engines: RuntimeEngineStatus[];
	    multiple_running: boolean;
	    homebrew_available: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ContainerRuntimeStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.engines = this.convertValues(source["engines"], RuntimeEngineStatus);
	        this.multiple_running = source["multiple_running"];
	        this.homebrew_available = source["homebrew_available"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DeviceCode {
	    user_code: string;
	    verification_uri: string;
	    interval: number;
	    expires_in: number;
	
	    static createFrom(source: any = {}) {
	        return new DeviceCode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user_code = source["user_code"];
	        this.verification_uri = source["verification_uri"];
	        this.interval = source["interval"];
	        this.expires_in = source["expires_in"];
	    }
	}
	export class DiskStats {
	    mount_point: string;
	    total_bytes: number;
	    used_bytes: number;
	    free_bytes: number;
	    used_percent: number;
	
	    static createFrom(source: any = {}) {
	        return new DiskStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mount_point = source["mount_point"];
	        this.total_bytes = source["total_bytes"];
	        this.used_bytes = source["used_bytes"];
	        this.free_bytes = source["free_bytes"];
	        this.used_percent = source["used_percent"];
	    }
	}
	export class EnvFileSummary {
	    project_path: string;
	    project_name: string;
	    file_name: string;
	    keys: string[];
	
	    static createFrom(source: any = {}) {
	        return new EnvFileSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.project_path = source["project_path"];
	        this.project_name = source["project_name"];
	        this.file_name = source["file_name"];
	        this.keys = source["keys"];
	    }
	}
	export class FileChange {
	    path: string;
	    status: string;
	    staged: boolean;
	    conflict: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileChange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.status = source["status"];
	        this.staged = source["staged"];
	        this.conflict = source["conflict"];
	    }
	}
	export class GPUInfo {
	    name: string;
	    cores?: string;
	    vram?: string;
	
	    static createFrom(source: any = {}) {
	        return new GPUInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.cores = source["cores"];
	        this.vram = source["vram"];
	    }
	}
	
	export class GitHookStatus {
	    pre_commit: boolean;
	    pre_push: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitHookStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pre_commit = source["pre_commit"];
	        this.pre_push = source["pre_push"];
	    }
	}
	export class GitHubCLIAccount {
	    login: string;
	    active: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitHubCLIAccount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.login = source["login"];
	        this.active = source["active"];
	    }
	}
	export class GitHubStatus {
	    configured: boolean;
	    authenticated: boolean;
	    login?: string;
	    repo?: string;
	    message?: string;
	    source?: string;
	
	    static createFrom(source: any = {}) {
	        return new GitHubStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.authenticated = source["authenticated"];
	        this.login = source["login"];
	        this.repo = source["repo"];
	        this.message = source["message"];
	        this.source = source["source"];
	    }
	}
	export class GraphCommit {
	    hash: string;
	    parents: string[];
	    refs: string[];
	    head: boolean;
	    subject: string;
	    author: string;
	    occurred_at: string;
	
	    static createFrom(source: any = {}) {
	        return new GraphCommit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.parents = source["parents"];
	        this.refs = source["refs"];
	        this.head = source["head"];
	        this.subject = source["subject"];
	        this.author = source["author"];
	        this.occurred_at = source["occurred_at"];
	    }
	}
	export class HealthSamplePoint {
	    at: string;
	    state: string;
	    latency: number;
	
	    static createFrom(source: any = {}) {
	        return new HealthSamplePoint(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.at = source["at"];
	        this.state = source["state"];
	        this.latency = source["latency"];
	    }
	}
	export class HealthStatus {
	    name: string;
	    type: string;
	    target: string;
	    state: string;
	    message: string;
	    latency: number;
	    status_code: number;
	    checked_at: string;
	
	    static createFrom(source: any = {}) {
	        return new HealthStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.target = source["target"];
	        this.state = source["state"];
	        this.message = source["message"];
	        this.latency = source["latency"];
	        this.status_code = source["status_code"];
	        this.checked_at = source["checked_at"];
	    }
	}
	export class InstalledApp {
	    name: string;
	    bundle_id: string;
	    version: string;
	    path: string;
	    running: boolean;
	    cpu_percent: number;
	    mem_percent: number;
	    icon?: string;
	
	    static createFrom(source: any = {}) {
	        return new InstalledApp(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.bundle_id = source["bundle_id"];
	        this.version = source["version"];
	        this.path = source["path"];
	        this.running = source["running"];
	        this.cpu_percent = source["cpu_percent"];
	        this.mem_percent = source["mem_percent"];
	        this.icon = source["icon"];
	    }
	}
	export class Job {
	    id: string;
	    name: string;
	    source: string;
	    status: string;
	    command: string;
	    schedule?: string;
	    container_id?: string;
	    pid?: number;
	    project?: string;
	    processes?: string[];
	
	    static createFrom(source: any = {}) {
	        return new Job(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.source = source["source"];
	        this.status = source["status"];
	        this.command = source["command"];
	        this.schedule = source["schedule"];
	        this.container_id = source["container_id"];
	        this.pid = source["pid"];
	        this.project = source["project"];
	        this.processes = source["processes"];
	    }
	}
	export class MemoryStats {
	    total_bytes: number;
	    used_bytes: number;
	    free_bytes: number;
	    used_percent: number;
	
	    static createFrom(source: any = {}) {
	        return new MemoryStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total_bytes = source["total_bytes"];
	        this.used_bytes = source["used_bytes"];
	        this.free_bytes = source["free_bytes"];
	        this.used_percent = source["used_percent"];
	    }
	}
	export class NetworkInterfaceStats {
	    name: string;
	    rx_bytes_per_sec: number;
	    tx_bytes_per_sec: number;
	    total_rx_bytes: number;
	    total_tx_bytes: number;
	
	    static createFrom(source: any = {}) {
	        return new NetworkInterfaceStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.rx_bytes_per_sec = source["rx_bytes_per_sec"];
	        this.tx_bytes_per_sec = source["tx_bytes_per_sec"];
	        this.total_rx_bytes = source["total_rx_bytes"];
	        this.total_tx_bytes = source["total_tx_bytes"];
	    }
	}
	
	export class PortUsage {
	    port: number;
	    protocol: string;
	    address: string;
	    process: string;
	    pid: number;
	    source: string;
	    container_id?: string;
	    name?: string;
	    command?: string;
	    project?: string;
	
	    static createFrom(source: any = {}) {
	        return new PortUsage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.port = source["port"];
	        this.protocol = source["protocol"];
	        this.address = source["address"];
	        this.process = source["process"];
	        this.pid = source["pid"];
	        this.source = source["source"];
	        this.container_id = source["container_id"];
	        this.name = source["name"];
	        this.command = source["command"];
	        this.project = source["project"];
	    }
	}
	export class ProcessInfo {
	    pid: number;
	    ppid: number;
	    user: string;
	    cpu_percent: number;
	    mem_percent: number;
	    rss_bytes: number;
	    command: string;
	    path: string;
	    ports?: number[];
	    project?: string;
	
	    static createFrom(source: any = {}) {
	        return new ProcessInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pid = source["pid"];
	        this.ppid = source["ppid"];
	        this.user = source["user"];
	        this.cpu_percent = source["cpu_percent"];
	        this.mem_percent = source["mem_percent"];
	        this.rss_bytes = source["rss_bytes"];
	        this.command = source["command"];
	        this.path = source["path"];
	        this.ports = source["ports"];
	        this.project = source["project"];
	    }
	}
	export class ProjectGroup {
	    name: string;
	    services: discovery.Service[];
	    total: number;
	    healthy: number;
	    degraded: number;
	    down: number;
	
	    static createFrom(source: any = {}) {
	        return new ProjectGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.services = this.convertValues(source["services"], discovery.Service);
	        this.total = source["total"];
	        this.healthy = source["healthy"];
	        this.degraded = source["degraded"];
	        this.down = source["down"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectToolRequirement {
	    project: string;
	    path: string;
	    required: string[];
	    missing: string[];
	
	    static createFrom(source: any = {}) {
	        return new ProjectToolRequirement(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.project = source["project"];
	        this.path = source["path"];
	        this.required = source["required"];
	        this.missing = source["missing"];
	    }
	}
	export class PullRequest {
	    number: number;
	    title: string;
	    author: string;
	    head_ref: string;
	    base_ref: string;
	    state: string;
	    is_draft: boolean;
	    url: string;
	    updated_at: string;
	    review_decision: string;
	    labels?: string[];
	
	    static createFrom(source: any = {}) {
	        return new PullRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.number = source["number"];
	        this.title = source["title"];
	        this.author = source["author"];
	        this.head_ref = source["head_ref"];
	        this.base_ref = source["base_ref"];
	        this.state = source["state"];
	        this.is_draft = source["is_draft"];
	        this.url = source["url"];
	        this.updated_at = source["updated_at"];
	        this.review_decision = source["review_decision"];
	        this.labels = source["labels"];
	    }
	}
	export class PullRequestComment {
	    author: string;
	    body: string;
	    created_at: string;
	
	    static createFrom(source: any = {}) {
	        return new PullRequestComment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.author = source["author"];
	        this.body = source["body"];
	        this.created_at = source["created_at"];
	    }
	}
	export class PullRequestCommit {
	    sha: string;
	    message: string;
	    author: string;
	    date: string;
	
	    static createFrom(source: any = {}) {
	        return new PullRequestCommit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sha = source["sha"];
	        this.message = source["message"];
	        this.author = source["author"];
	        this.date = source["date"];
	    }
	}
	export class PullRequestCounts {
	    open: number;
	    closed: number;
	    merged: number;
	
	    static createFrom(source: any = {}) {
	        return new PullRequestCounts(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.open = source["open"];
	        this.closed = source["closed"];
	        this.merged = source["merged"];
	    }
	}
	export class PullRequestDetail {
	    number: number;
	    title: string;
	    body: string;
	    author: string;
	    url: string;
	    diff: string;
	    comments: PullRequestComment[];
	    state: string;
	    is_draft: boolean;
	    mergeable: boolean;
	    head_ref: string;
	    head_sha: string;
	    base_ref: string;
	    labels?: string[];
	    requested_reviewers?: string[];
	    assignees?: string[];
	
	    static createFrom(source: any = {}) {
	        return new PullRequestDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.number = source["number"];
	        this.title = source["title"];
	        this.body = source["body"];
	        this.author = source["author"];
	        this.url = source["url"];
	        this.diff = source["diff"];
	        this.comments = this.convertValues(source["comments"], PullRequestComment);
	        this.state = source["state"];
	        this.is_draft = source["is_draft"];
	        this.mergeable = source["mergeable"];
	        this.head_ref = source["head_ref"];
	        this.head_sha = source["head_sha"];
	        this.base_ref = source["base_ref"];
	        this.labels = source["labels"];
	        this.requested_reviewers = source["requested_reviewers"];
	        this.assignees = source["assignees"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PullRequestFile {
	    filename: string;
	    previous_filename?: string;
	    status: string;
	    additions: number;
	    deletions: number;
	    patch?: string;
	
	    static createFrom(source: any = {}) {
	        return new PullRequestFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.previous_filename = source["previous_filename"];
	        this.status = source["status"];
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	        this.patch = source["patch"];
	    }
	}
	export class PullRequestFilter {
	    state: string;
	    author: string;
	    label: string;
	    search: string;
	
	    static createFrom(source: any = {}) {
	        return new PullRequestFilter(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.author = source["author"];
	        this.label = source["label"];
	        this.search = source["search"];
	    }
	}
	export class RegistryPackage {
	    name: string;
	    description?: string;
	
	    static createFrom(source: any = {}) {
	        return new RegistryPackage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	    }
	}
	export class RemoteContainer {
	    id: string;
	    name: string;
	    image: string;
	    status: string;
	    state: string;
	    ports: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoteContainer(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.image = source["image"];
	        this.status = source["status"];
	        this.state = source["state"];
	        this.ports = source["ports"];
	    }
	}
	export class RemoteContainerStatus {
	    name: string;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoteContainerStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.status = source["status"];
	    }
	}
	export class RemoteFile {
	    name: string;
	    is_dir: boolean;
	    size: number;
	    mod_time: number;
	
	    static createFrom(source: any = {}) {
	        return new RemoteFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.is_dir = source["is_dir"];
	        this.size = source["size"];
	        this.mod_time = source["mod_time"];
	    }
	}
	export class RepoBranch {
	    name: string;
	    current: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RepoBranch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.current = source["current"];
	    }
	}
	export class RepoEntry {
	    name: string;
	    dir: boolean;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new RepoEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dir = source["dir"];
	        this.size = source["size"];
	    }
	}
	
	export class ResourceSample {
	    at: string;
	    cpu_percent: number;
	    mem_percent: number;
	    disk_percent: number;
	    net_rx_bytes_per_sec: number;
	    net_tx_bytes_per_sec: number;
	    top_process?: string;
	
	    static createFrom(source: any = {}) {
	        return new ResourceSample(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.at = source["at"];
	        this.cpu_percent = source["cpu_percent"];
	        this.mem_percent = source["mem_percent"];
	        this.disk_percent = source["disk_percent"];
	        this.net_rx_bytes_per_sec = source["net_rx_bytes_per_sec"];
	        this.net_tx_bytes_per_sec = source["net_tx_bytes_per_sec"];
	        this.top_process = source["top_process"];
	    }
	}
	export class SwapStats {
	    total_mb: number;
	    used_mb: number;
	    free_mb: number;
	
	    static createFrom(source: any = {}) {
	        return new SwapStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total_mb = source["total_mb"];
	        this.used_mb = source["used_mb"];
	        this.free_mb = source["free_mb"];
	    }
	}
	export class ResourceSnapshot {
	    cpu: CPUStats;
	    memory: MemoryStats;
	    swap: SwapStats;
	    disks: DiskStats[];
	    network: NetworkInterfaceStats[];
	    processes: ProcessInfo[];
	    gpus?: GPUInfo[];
	    battery?: BatteryInfo;
	    thermal?: string;
	    sampled_at: string;
	
	    static createFrom(source: any = {}) {
	        return new ResourceSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cpu = this.convertValues(source["cpu"], CPUStats);
	        this.memory = this.convertValues(source["memory"], MemoryStats);
	        this.swap = this.convertValues(source["swap"], SwapStats);
	        this.disks = this.convertValues(source["disks"], DiskStats);
	        this.network = this.convertValues(source["network"], NetworkInterfaceStats);
	        this.processes = this.convertValues(source["processes"], ProcessInfo);
	        this.gpus = this.convertValues(source["gpus"], GPUInfo);
	        this.battery = this.convertValues(source["battery"], BatteryInfo);
	        this.thermal = source["thermal"];
	        this.sampled_at = source["sampled_at"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ReviewComment {
	    id: number;
	    path: string;
	    line: number;
	    side: string;
	    start_line?: number;
	    start_side?: string;
	    body: string;
	    author: string;
	    created_at: string;
	    in_reply_to?: number;
	
	    static createFrom(source: any = {}) {
	        return new ReviewComment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path = source["path"];
	        this.line = source["line"];
	        this.side = source["side"];
	        this.start_line = source["start_line"];
	        this.start_side = source["start_side"];
	        this.body = source["body"];
	        this.author = source["author"];
	        this.created_at = source["created_at"];
	        this.in_reply_to = source["in_reply_to"];
	    }
	}
	
	export class SSHConfigHost {
	    alias: string;
	    host: string;
	    port: number;
	    user: string;
	    key_path: string;
	    proxy_jump?: string;
	
	    static createFrom(source: any = {}) {
	        return new SSHConfigHost(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.key_path = source["key_path"];
	        this.proxy_jump = source["proxy_jump"];
	    }
	}
	
	export class ServerHealth {
	    reachable: boolean;
	    uptime: string;
	    cpu_percent: number;
	    memory: string;
	    mem_percent: number;
	    disk: string;
	    disk_percent: number;
	    docker_available: boolean;
	    containers: RemoteContainerStatus[];
	    raw: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ServerHealth(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reachable = source["reachable"];
	        this.uptime = source["uptime"];
	        this.cpu_percent = source["cpu_percent"];
	        this.memory = source["memory"];
	        this.mem_percent = source["mem_percent"];
	        this.disk = source["disk"];
	        this.disk_percent = source["disk_percent"];
	        this.docker_available = source["docker_available"];
	        this.containers = this.convertValues(source["containers"], RemoteContainerStatus);
	        this.raw = source["raw"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Snapshot {
	    services: discovery.Service[];
	    ports: PortUsage[];
	    jobs: Job[];
	    projects: ProjectGroup[];
	    anomalies: Anomaly[];
	    scanned_at: string;
	    docker_status?: string;
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.services = this.convertValues(source["services"], discovery.Service);
	        this.ports = this.convertValues(source["ports"], PortUsage);
	        this.jobs = this.convertValues(source["jobs"], Job);
	        this.projects = this.convertValues(source["projects"], ProjectGroup);
	        this.anomalies = this.convertValues(source["anomalies"], Anomaly);
	        this.scanned_at = source["scanned_at"];
	        this.docker_status = source["docker_status"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TimelineEvent {
	    id: string;
	    at: string;
	    category: string;
	    name: string;
	    project?: string;
	    target_type: string;
	    target_id?: string;
	    kind: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new TimelineEvent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.at = source["at"];
	        this.category = source["category"];
	        this.name = source["name"];
	        this.project = source["project"];
	        this.target_type = source["target_type"];
	        this.target_id = source["target_id"];
	        this.kind = source["kind"];
	        this.message = source["message"];
	    }
	}
	export class ToolActionStatus {
	    running: boolean;
	    output: string;
	    exit_code: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ToolActionStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.output = source["output"];
	        this.exit_code = source["exit_code"];
	        this.error = source["error"];
	    }
	}
	export class ToolInfo {
	    name: string;
	    command: string;
	    installed: boolean;
	    version?: string;
	    path?: string;
	    install_command?: string;
	    update_command?: string;
	    managed_by?: string;
	    install_blocked_reason?: string;
	
	    static createFrom(source: any = {}) {
	        return new ToolInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.command = source["command"];
	        this.installed = source["installed"];
	        this.version = source["version"];
	        this.path = source["path"];
	        this.install_command = source["install_command"];
	        this.update_command = source["update_command"];
	        this.managed_by = source["managed_by"];
	        this.install_blocked_reason = source["install_blocked_reason"];
	    }
	}
	export class ToolsSnapshot {
	    tools: ToolInfo[];
	    projects: ProjectToolRequirement[];
	    sampled_at: string;
	
	    static createFrom(source: any = {}) {
	        return new ToolsSnapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tools = this.convertValues(source["tools"], ToolInfo);
	        this.projects = this.convertValues(source["projects"], ProjectToolRequirement);
	        this.sampled_at = source["sampled_at"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class UpdateInfo {
	    current_version: string;
	    latest_version?: string;
	    available: boolean;
	    release_url?: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current_version = source["current_version"];
	        this.latest_version = source["latest_version"];
	        this.available = source["available"];
	        this.release_url = source["release_url"];
	        this.error = source["error"];
	    }
	}
	export class VPNFieldDef {
	    key: string;
	    label: string;
	    placeholder?: string;
	    secret?: boolean;
	    required?: boolean;
	    multiline?: boolean;
	    span: string;
	
	    static createFrom(source: any = {}) {
	        return new VPNFieldDef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.label = source["label"];
	        this.placeholder = source["placeholder"];
	        this.secret = source["secret"];
	        this.required = source["required"];
	        this.multiline = source["multiline"];
	        this.span = source["span"];
	    }
	}
	export class VPNEngineInfo {
	    kind: string;
	    name: string;
	    installed: boolean;
	    fields: VPNFieldDef[];
	    binary: string;
	    install_command?: string;
	
	    static createFrom(source: any = {}) {
	        return new VPNEngineInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.name = source["name"];
	        this.installed = source["installed"];
	        this.fields = this.convertValues(source["fields"], VPNFieldDef);
	        this.binary = source["binary"];
	        this.install_command = source["install_command"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class VPNStatus {
	    configured: boolean;
	    connected: boolean;
	
	    static createFrom(source: any = {}) {
	        return new VPNStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.configured = source["configured"];
	        this.connected = source["connected"];
	    }
	}

}

export namespace security {
	
	export class Finding {
	    scanner: string;
	    tool: string;
	    severity: string;
	    title: string;
	    detail?: string;
	    file?: string;
	    line?: number;
	    rule_id?: string;
	
	    static createFrom(source: any = {}) {
	        return new Finding(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.scanner = source["scanner"];
	        this.tool = source["tool"];
	        this.severity = source["severity"];
	        this.title = source["title"];
	        this.detail = source["detail"];
	        this.file = source["file"];
	        this.line = source["line"];
	        this.rule_id = source["rule_id"];
	    }
	}
	export class ScannerStatus {
	    scanner: string;
	    tool?: string;
	    skipped: boolean;
	    reason?: string;
	
	    static createFrom(source: any = {}) {
	        return new ScannerStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.scanner = source["scanner"];
	        this.tool = source["tool"];
	        this.skipped = source["skipped"];
	        this.reason = source["reason"];
	    }
	}
	export class Report {
	    path: string;
	    // Go type: time
	    scanned_at: any;
	    findings: Finding[];
	    statuses: ScannerStatus[];
	    counts: Record<string, number>;
	
	    static createFrom(source: any = {}) {
	        return new Report(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.scanned_at = this.convertValues(source["scanned_at"], null);
	        this.findings = this.convertValues(source["findings"], Finding);
	        this.statuses = this.convertValues(source["statuses"], ScannerStatus);
	        this.counts = source["counts"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

