//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework Cocoa
void ThalocaInstallMenuBar(void);
*/
import "C"

import (
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

// menuBarApp is the single App instance the menu bar's cgo-exported
// callbacks below dispatch into — set once from setupMenuBar, mirroring how
// main.go already only ever constructs one App.
var menuBarApp *App

var (
	menuBarSnapshotMu   sync.RWMutex
	menuBarSnapshotJSON = `{"engine_kind":"docker-desktop","engine_name":"Docker Desktop","engine_running":false,"projects":[]}`
	menuBarRefreshMu    sync.Mutex
)

func setupMenuBar(app *App) {
	menuBarApp = app
	C.ThalocaInstallMenuBar()
	go refreshMenuBarSnapshot()
}

// menuBarContainer is one container as the native menu (menu_bar_darwin.m)
// needs it — a trimmed-down discovery.Service.
type menuBarContainer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// menuBarProject groups containers under the compose project they belong
// to (Key/Name both "" become the display name "Standalone" for containers
// with no compose project) — mirrors the by-project grouping the Runtime
// view's main container list already uses, plus Start all/Stop all.
type menuBarProject struct {
	Key        string             `json:"key"`
	Name       string             `json:"name"`
	Containers []menuBarContainer `json:"containers"`
}

// menuBarSnapshot is what ThalocaMenuBarSnapshot hands the menu each time
// it's about to be shown, so it always reflects live state instead of
// whatever it looked like when the app launched.
type menuBarSnapshot struct {
	EngineKind    string           `json:"engine_kind"`
	EngineName    string           `json:"engine_name"`
	EngineRunning bool             `json:"engine_running"`
	Projects      []menuBarProject `json:"projects"`
}

// menuBarStoppedContainerMaxAge bounds how long an exited container keeps
// showing in the tray menu. Without this, `docker ps -a` — which the
// Runtime view's full container list intentionally shows in full, history
// and all — would surface every container ever run on this machine,
// including ones from projects abandoned weeks ago; the tray is meant for
// an at-a-glance, currently-relevant view, not an archive.
const menuBarStoppedContainerMaxAge = 48 * time.Hour

// ThalocaMenuBarSnapshot returns the most recently refreshed JSON snapshot.
// It never shells out: AppKit calls this synchronously while opening the
// menu, so doing Docker discovery here would freeze the Cocoa main thread.
//
//export ThalocaMenuBarSnapshot
func ThalocaMenuBarSnapshot() *C.char {
	menuBarSnapshotMu.RLock()
	data := menuBarSnapshotJSON
	menuBarSnapshotMu.RUnlock()
	return C.CString(data)
}

// ThalocaMenuBarRefreshSnapshot performs the comparatively slow Docker
// discovery. Objective-C only calls it from a background queue (and Go calls
// it once at startup), leaving the cached snapshot safe for the main thread.
//
//export ThalocaMenuBarRefreshSnapshot
func ThalocaMenuBarRefreshSnapshot() {
	refreshMenuBarSnapshot()
}

func refreshMenuBarSnapshot() {
	// menu close, a tray action, and the periodic loop can all request a
	// refresh at nearly the same time. Serialize them so they don't launch
	// duplicate docker/inspect subprocesses or let an older result overwrite
	// a newer snapshot.
	menuBarRefreshMu.Lock()
	defer menuBarRefreshMu.Unlock()

	snap := menuBarSnapshot{EngineKind: "docker-desktop", EngineName: "Docker Desktop"}
	if menuBarApp != nil {
		status := menuBarApp.GetContainerRuntimeStatus()
		for _, e := range status.Engines {
			if e.Running {
				snap.EngineKind, snap.EngineName, snap.EngineRunning = e.Kind, e.Name, true
				break
			}
		}
		if !snap.EngineRunning {
			for _, e := range status.Engines {
				if e.Installed {
					snap.EngineKind, snap.EngineName = e.Kind, e.Name
					break
				}
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		services, _, _ := discovery.ScanDocker(ctx)
		services = filterRecentMenuBarContainers(ctx, services, menuBarStoppedContainerMaxAge)
		snap.Projects = groupMenuBarContainers(services)
	}

	data, err := json.Marshal(snap)
	if err != nil {
		return
	}
	menuBarSnapshotMu.Lock()
	menuBarSnapshotJSON = string(data)
	menuBarSnapshotMu.Unlock()
}

// filterRecentMenuBarContainers drops exited containers older than maxAge,
// determined via one batched `docker inspect` call (rather than one per
// container) keyed by argument order — `docker ps`'s own JSON output has no
// exact stop time, only a human string like "Exited (0) 9 days ago". Fails
// open (returns services unfiltered) if inspect itself fails, so a
// transient error never hides every container instead of just the stale
// ones.
func filterRecentMenuBarContainers(ctx context.Context, services []discovery.Service, maxAge time.Duration) []discovery.Service {
	var stoppedIDs []string
	for _, s := range services {
		if s.Status == "stopped" {
			stoppedIDs = append(stoppedIDs, s.ContainerID)
		}
	}
	if len(stoppedIDs) == 0 {
		return services
	}

	args := append([]string{"inspect", "--format", "{{.State.FinishedAt}}"}, stoppedIDs...)
	out, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return services
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != len(stoppedIDs) {
		return services
	}

	finishedByID := make(map[string]time.Time, len(stoppedIDs))
	for i, line := range lines {
		if t, perr := time.Parse(time.RFC3339Nano, strings.TrimSpace(line)); perr == nil {
			finishedByID[stoppedIDs[i]] = t
		}
	}

	cutoff := time.Now().Add(-maxAge)
	kept := make([]discovery.Service, 0, len(services))
	for _, s := range services {
		if s.Status != "stopped" {
			kept = append(kept, s)
			continue
		}
		if t, ok := finishedByID[s.ContainerID]; ok && t.After(cutoff) {
			kept = append(kept, s)
		}
	}
	return kept
}

// groupMenuBarContainers buckets containers by compose project (Service's
// "" Project becomes the "Standalone" bucket), named projects sorted
// alphabetically with Standalone always last.
func groupMenuBarContainers(services []discovery.Service) []menuBarProject {
	groups := map[string]*menuBarProject{}
	var namedKeys []string
	hasStandalone := false
	for _, s := range services {
		if s.ContainerID == "" {
			continue
		}
		key := s.Project
		g, ok := groups[key]
		if !ok {
			name := key
			if name == "" {
				name = "Standalone"
				hasStandalone = true
			} else {
				namedKeys = append(namedKeys, key)
			}
			g = &menuBarProject{Key: key, Name: name}
			groups[key] = g
		}
		g.Containers = append(g.Containers, menuBarContainer{ID: s.ContainerID, Name: s.Name, Status: s.Status})
	}

	sort.Strings(namedKeys)
	order := namedKeys
	if hasStandalone {
		order = append(order, "")
	}

	projects := make([]menuBarProject, 0, len(order))
	for _, key := range order {
		projects = append(projects, *groups[key])
	}
	return projects
}

// ThalocaMenuBarProjectAction starts, stops, or restarts every container in
// one compose project (project == "" for the Standalone bucket) at once —
// the tray's "Start all"/"Stop all"/"Restart all" per project. Re-scans
// rather than trusting
// a container ID list from the frontend, since the snapshot the menu is
// showing could be a few seconds stale.
//
//export ThalocaMenuBarProjectAction
func ThalocaMenuBarProjectAction(project *C.char, action *C.char) *C.char {
	if menuBarApp == nil {
		return C.CString("")
	}
	key := C.GoString(project)
	act := C.GoString(action)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	services, _, _ := discovery.ScanDocker(ctx)

	var errs []string
	for _, s := range services {
		if s.Project != key || s.ContainerID == "" {
			continue
		}
		var err error
		switch act {
		case "start-all":
			err = menuBarApp.StartContainer(s.ContainerID)
		case "stop-all":
			err = menuBarApp.StopContainer(s.ContainerID)
		case "restart-all":
			err = menuBarApp.RestartContainer(s.ContainerID)
		}
		if err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return C.CString(strings.Join(errs, "; "))
	}
	return C.CString("")
}

// ThalocaMenuBarOpenEngine opens/starts the named container engine (the
// "Open Docker Desktop"/"Open OrbStack" menu item), reusing the same
// StartContainerRuntime the Runtime view's engine cards call.
//
//export ThalocaMenuBarOpenEngine
func ThalocaMenuBarOpenEngine(kind *C.char) *C.char {
	if menuBarApp == nil {
		return C.CString("")
	}
	if err := menuBarApp.StartContainerRuntime(C.GoString(kind)); err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}

// ThalocaMenuBarContainerAction starts, stops, or restarts one container by
// ID, reusing the same StartContainer/StopContainer/RestartContainer the
// Runtime view's container rows call.
//
//export ThalocaMenuBarContainerAction
func ThalocaMenuBarContainerAction(id *C.char, action *C.char) *C.char {
	if menuBarApp == nil {
		return C.CString("")
	}
	containerID := C.GoString(id)
	var err error
	switch C.GoString(action) {
	case "start":
		err = menuBarApp.StartContainer(containerID)
	case "stop":
		err = menuBarApp.StopContainer(containerID)
	case "restart":
		err = menuBarApp.RestartContainer(containerID)
	}
	if err != nil {
		return C.CString(err.Error())
	}
	return C.CString("")
}
