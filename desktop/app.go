package main

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"thaloca.local/thaloca/internal/discovery"
)

// Service is shared with cmd/thaloca via internal/discovery — a Docker
// container, local process, or git repository as one discoverable unit.
type Service = discovery.Service

// PortUsage represents a local port currently in use.
type PortUsage struct {
	Port        int    `json:"port"`
	Protocol    string `json:"protocol"`
	Address     string `json:"address"`
	Process     string `json:"process"`
	PID         int    `json:"pid"`
	Source      string `json:"source"`
	ContainerID string `json:"container_id,omitempty"`
	Name        string `json:"name,omitempty"`
	Command     string `json:"command,omitempty"`
	Project     string `json:"project,omitempty"`
}

// Job represents a discovered scheduled/background job.
type Job struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Source      string   `json:"source"`
	Status      string   `json:"status"`
	Command     string   `json:"command"`
	Schedule    string   `json:"schedule,omitempty"`
	ContainerID string   `json:"container_id,omitempty"`
	PID         int      `json:"pid,omitempty"`
	Project     string   `json:"project,omitempty"`
	Processes   []string `json:"processes,omitempty"`
}

// HealthStatus represents a health check result
type HealthStatus struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Target     string `json:"target"`
	State      string `json:"state"`
	Message    string `json:"message"`
	Latency    int64  `json:"latency"`
	StatusCode int    `json:"status_code"`
	CheckedAt  string `json:"checked_at"`
}

type App struct {
	ctx context.Context

	ghMu              sync.Mutex
	ghDeviceCode      string    // OAuth device flow in progress
	ghDeviceExpiresAt time.Time // when ghDeviceCode stops being valid

	repoCacheMu sync.Mutex
	repoCache   []string
	repoCacheAt time.Time

	scanMu    sync.Mutex
	scanState map[string]*serviceScanState

	// logAnomalyState throttles and dedupes log-based anomaly detection
	// (see desktop/logAnomalies.go) — in memory only, cleared on restart.
	logAnomalyMu    sync.Mutex
	logAnomalyState map[string]*logAnomalyState

	// notifyLast throttles native notifications per problem key (see
	// desktop/notifications.go's notifyOnce).
	notifyMu   sync.Mutex
	notifyLast map[string]time.Time

	// serverReachable tracks each saved server's last-known SSH
	// reachability so pollServerReachability can notify only on a
	// reachable->unreachable transition, not on every poll.
	serverReachMu        sync.Mutex
	serverReachable      map[string]bool
	serverReachBaselined bool

	// resourceHistory is a bounded, in-memory 24h ring of sampled resource
	// usage (see desktop/resourceHistory.go) — never persisted, cleared on
	// restart.
	resourceHistoryMu sync.Mutex
	resourceHistory   []ResourceSample

	healthMu      sync.Mutex
	healthHistory map[string][]healthSample

	eventMu sync.Mutex
	events  []TimelineEvent

	jobMu        sync.Mutex
	jobSeen      map[string]Job
	jobBaselined bool

	portMu        sync.Mutex
	portOwner     map[int]string
	portBaselined bool

	netMu   sync.Mutex
	netPrev map[string]netSample

	// gpuCache holds GPU info (system_profiler is slow, ~200ms, and this
	// data is static for the life of the process) so Resources() only pays
	// that cost once instead of on every poll.
	gpuMu     sync.Mutex
	gpuCache  []GPUInfo
	gpuCached bool

	// toolsCache holds the last Tools() scan. Detecting tools is read-only
	// and versions essentially never change mid-session, so Tools() serves
	// this cache and only RefreshTools() (the tab's "Refresh" button) pays
	// the ~150-200ms cost of actually re-running every version command.
	toolsMu    sync.Mutex
	toolsCache *ToolsSnapshot

	// toolJobs holds live install/update commands started via
	// RunToolAction, keyed by job ID, so ToolActionStatus can be polled for
	// their output while they run (see desktop/toolActions.go).
	toolJobsMu sync.Mutex
	toolJobs   map[string]*toolJob

	// terminals holds live PTY-backed server terminal sessions started via
	// OpenServerTerminal, keyed by session ID (see desktop/serverTerminal.go).
	terminalsMu sync.Mutex
	terminals   map[string]*terminalSession

	// appsCache holds installed .app bundles' static metadata (see
	// apps.go) — like toolsCache/gpuCache, only re-scanned via
	// RefreshInstalledApps rather than on every Resources poll.
	appsMu    sync.Mutex
	appsCache []InstalledApp
}

func NewApp() *App {
	return &App{}
}

func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx

	// Warm the GPU info cache in the background so the first visit to the
	// Resources tab doesn't pay system_profiler's ~200ms cost itself.
	go a.readGPUInfoCached(context.Background())

	// Same idea for Tools(): warm its cache (which also warms the repo path
	// scan GetActivity() relies on) so the first visit to either tab isn't
	// the one paying for it.
	go a.RefreshTools()

	// Same idea for the installed-apps list: scanning /Applications and
	// reading every bundle's Info.plist via `plutil` isn't cheap, so warm
	// it in the background rather than making the first Resources visit
	// pay for it.
	go a.RefreshInstalledApps()

	// Server reachability is polled independently of the Servers tab being
	// open, so a server going offline can be noticed and notified about
	// even while the user is elsewhere in the app.
	go a.pollServerReachability()

	// Resource history is sampled independently of the Resources tab being
	// open too, so a meaningful 24h history exists whenever it's visited.
	go a.sampleResourceHistoryLoop()

	// System-wide clipboard capture — the user explicitly asked for copies
	// made in any app, not just inside Thaloca, to show up in the copy
	// history panel.
	go a.pollSystemClipboard()
}

// Shutdown runs on a real app quit (Cmd+Q / Dock Quit) — NOT on the window's
// close button, which only hides the window (see HideWindowOnClose in
// main.go) so background scanning keeps running. It closes any live server
// terminal sessions so no `ssh` subprocess is left orphaned.
func (a *App) Shutdown(ctx context.Context) {
	a.closeAllServerTerminals()
}

// Discover, DiscoverPorts, DiscoverJobs, and Overview used to live here as
// separate bindings; the frontend always called all four together on every
// refresh (see doLoadRuntime in main.ts), and Overview redid the same
// service/job discovery the other three had just done. They're now one
// binding, Snapshot() (see desktop/overview.go).

// Confirm shows a native confirmation dialog. WKWebView does not implement
// window.confirm, so the frontend must use this binding instead.
func (a *App) Confirm(title, message string) bool {
	result, err := wailsruntime.MessageDialog(a.ctx, wailsruntime.MessageDialogOptions{
		Type:          wailsruntime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"Yes", "Cancel"},
		DefaultButton: "Yes",
		CancelButton:  "Cancel",
	})
	if err != nil {
		return false
	}
	return result == "Yes"
}

// Notify sends a macOS native notification
func (a *App) Notify(title, message string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("notifications only supported on macOS")
	}
	escape := func(s string) string { return strings.ReplaceAll(s, `"`, `\"`) }
	script := fmt.Sprintf(`display notification "%s" with title "%s"`, escape(message), escape(title))
	cmd := exec.Command("osascript", "-e", script)
	return cmd.Run()
}

// PickFolder opens a native folder picker
func (a *App) PickFolder() (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "Choose a project folder",
	})
}

// PickKeyFile opens a native file picker for an SSH private key (used by
// the Servers tab's Add Server form instead of typing a path by hand).
func (a *App) PickKeyFile() (string, error) {
	return wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title:           "Choose an SSH private key",
		ShowHiddenFiles: true,
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "Key files (*.pem, *.key)", Pattern: "*.pem;*.key"},
			{DisplayName: "All files", Pattern: "*.*"},
		},
	})
}

// ToggleFullscreen switches the window between fullscreen and its normal
// state and returns the new state.
func (a *App) ToggleFullscreen() bool {
	if wailsruntime.WindowIsFullscreen(a.ctx) {
		wailsruntime.WindowUnfullscreen(a.ctx)
		return false
	}
	wailsruntime.WindowFullscreen(a.ctx)
	return true
}

// IsFullscreen reports whether the window is currently fullscreen (e.g. the
// user used the native green button rather than Thaloca's own toggle).
func (a *App) IsFullscreen() bool {
	return wailsruntime.WindowIsFullscreen(a.ctx)
}

// ========== Discovery Engine ==========
