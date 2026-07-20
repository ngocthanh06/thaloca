package main

import (
	"context"
	"fmt"
	"sort"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

// ProjectGroup aggregates discovered services that share the same project
// (currently the Docker Compose project label; anything without one is
// grouped under "Unassigned"). Recomputed live on every Snapshot() call.
type ProjectGroup struct {
	Name          string    `json:"name"`
	Services      []Service `json:"services"`
	Total         int       `json:"total"`
	Healthy       int       `json:"healthy"`
	Degraded      int       `json:"degraded"`
	Down          int       `json:"down"`
	ExpectedState string    `json:"expected_state,omitempty"`
}

// Anomaly is a transient alert derived by diffing consecutive Snapshot()
// scans in memory (see App.scanState). It is never persisted and disappears
// once the app restarts or the underlying condition clears.
type Anomaly struct {
	ServiceID string `json:"service_id"`
	Name      string `json:"name"`
	Project   string `json:"project"`
	Kind      string `json:"kind"` // "restart_loop" | "degraded"
	Severity  string `json:"severity"`
	Message   string `json:"message"`
	Since     string `json:"since"`
}

// Snapshot is one discovery pass (Docker/process/git/ports/cron/launchd/
// PM2) plus everything derived from it — project grouping and anomaly
// detection. It replaces the previous Discover()/DiscoverPorts()/
// DiscoverJobs()/Overview() bindings, which the frontend always called
// together and which each re-scanned independently (Overview in particular
// used to redo the exact same discoverAll()+discoverJobs() the other three
// had just done). Nothing here is persisted to disk; it is recomputed live
// on every call.
type Snapshot struct {
	Services  []Service      `json:"services"`
	Ports     []PortUsage    `json:"ports"`
	Jobs      []Job          `json:"jobs"`
	Projects  []ProjectGroup `json:"projects"`
	Anomalies []Anomaly      `json:"anomalies"`
	ScannedAt string         `json:"scanned_at"`
	// DockerStatus is "" when Docker was reached fine (even with zero
	// containers); otherwise a human-readable reason it couldn't be reached
	// (CLI missing, daemon/OrbStack not running, wrong context, ...) — see
	// discoverAll's doc comment.
	DockerStatus string `json:"docker_status,omitempty"`
}

// serviceScanState tracks one service's recent status history across scans,
// purely in memory, to detect restart loops and prolonged degraded state.
type serviceScanState struct {
	lastStatus  string
	badSince    time.Time
	transitions []time.Time
}

// Snapshot runs the one discovery pass every view needs (Runtime's
// services/ports/jobs, Overview's project grouping and anomalies) and
// derives project groups and anomalies from it, surfacing anomalies
// (restart loops, prolonged degraded state, errored jobs) detected by
// diffing against the previous scan (see App.scanState). Everything here
// is recomputed live on every call; nothing is written to disk.
//
// Docker is scanned exactly once here and shared with discoverAll/
// discoverPorts/discoverJobs (previously each scanned it independently),
// and the git repo list comes from the same 5-minute cache Activity already
// uses (see cachedRepoPaths) instead of a fresh filesystem walk every call.
// force bypasses that cache's TTL — pass true for a user-initiated refresh
// (a repo cloned moments ago should show up immediately), false for the
// background auto-refresh.
func (a *App) Snapshot(force bool) Snapshot {
	// The two slow discovery sources — Docker (its contexts are scanned
	// sequentially, so a hung daemon can eat its whole deadline) and the
	// local process scan — run in parallel, each under its own 15-second
	// deadline. A slow Docker daemon therefore neither hides local services
	// (which an expired shared context used to) nor stretches a refresh to
	// the sum of both timeouts.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var dockerServices []discovery.Service
	var dockerContextStatuses []discovery.DockerContextStatus
	var dockerErr error
	dockerDone := make(chan struct{})
	go func() {
		defer close(dockerDone)
		dockerCtx, cancelDocker := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancelDocker()
		dockerServices, dockerContextStatuses, dockerErr = discovery.ScanDocker(dockerCtx)
	}()
	repoPaths := a.cachedRepoPaths(force)
	procServices, _ := discovery.ScanProcesses(ctx)
	<-dockerDone
	services, dockerStatus := discoverAll(repoPaths, procServices, dockerServices, dockerContextStatuses, dockerErr)
	ports := discoverPorts(ctx, dockerServices)
	jobs := discoverJobs(ctx, dockerServices)
	a.diffPortEvents(ports)
	a.diffJobEvents(jobs)

	projects := groupByProject(services)
	if projects == nil {
		projects = []ProjectGroup{}
	}
	anomalies := a.detectAnomalies(services)
	anomalies = append(anomalies, detectJobAnomalies(jobs)...)
	anomalies = append(anomalies, a.detectLogAnomalies(ctx, services)...)
	prefs := loadProductPreferences()
	for i := range projects {
		state := prefs.ExpectedProjects[projects[i].Name]
		if state == "" {
			state = "required"
		}
		projects[i].ExpectedState = state
		if state == "on_demand" || state == "muted" {
			projects[i].Down = 0
			projects[i].Degraded = 0
		}
	}
	filtered := anomalies[:0]
	for _, anomaly := range anomalies {
		state := prefs.ExpectedProjects[anomaly.Project]
		if state != "on_demand" && state != "muted" {
			filtered = append(filtered, anomaly)
		}
	}
	anomalies = filtered
	a.notifyAnomalies(anomalies)
	sort.Slice(anomalies, func(i, j int) bool { return anomalies[i].Severity < anomalies[j].Severity })
	if anomalies == nil {
		anomalies = []Anomaly{}
	}
	return Snapshot{
		Services:     services,
		Ports:        ports,
		Jobs:         jobs,
		Projects:     projects,
		Anomalies:    anomalies,
		ScannedAt:    time.Now().Format(time.RFC3339),
		DockerStatus: dockerStatus,
	}
}

func projectOrUnassigned(project string) string {
	if project == "" {
		return "Unassigned"
	}
	return project
}

// addServiceToGroup appends svc to the named group (creating it and
// recording its first-seen order if needed) and updates that group's
// health counters.
func addServiceToGroup(groups map[string]*ProjectGroup, order *[]string, name string, svc Service) {
	g, ok := groups[name]
	if !ok {
		g = &ProjectGroup{Name: name}
		groups[name] = g
		*order = append(*order, name)
	}
	g.Services = append(g.Services, svc)
	g.Total++
	switch svc.Status {
	case "running", "healthy", "active":
		g.Healthy++
	case "stopped", "unknown":
		g.Down++
	default:
		g.Degraded++
	}
}

// groupByProject groups discovered services by project. Docker Compose's
// project label (svc.Project) is the only signal used — a service without
// one (a plain process, or a git repository that isn't itself part of a
// Compose project) falls back to Unassigned rather than being folded into a
// same-named Compose project's card, so Overview's project cards only ever
// show the actual containers/processes Docker Compose says belong there.
func groupByProject(services []Service) []ProjectGroup {
	groups := map[string]*ProjectGroup{}
	var order []string

	for _, svc := range services {
		addServiceToGroup(groups, &order, projectOrUnassigned(svc.Project), svc)
	}

	sort.Strings(order)
	result := make([]ProjectGroup, 0, len(order))
	var unassigned *ProjectGroup
	for _, name := range order {
		if name == "Unassigned" {
			unassigned = groups[name]
			continue
		}
		result = append(result, *groups[name])
	}
	if unassigned != nil {
		result = append(result, *unassigned)
	}
	return result
}

// detectJobAnomalies flags jobs whose scheduler already reports a failed
// state. Unlike detectAnomalies (which tracks service status transitions
// over time to catch restart loops), PM2 reports "errored" directly, so no
// history/time-window tracking is needed here.
func detectJobAnomalies(jobs []Job) []Anomaly {
	var anomalies []Anomaly
	for _, job := range jobs {
		if job.Status != "errored" {
			continue
		}
		anomalies = append(anomalies, Anomaly{
			ServiceID: job.ID,
			Name:      job.Name,
			Project:   projectOrUnassigned(job.Project),
			Kind:      "job_failed",
			Severity:  "critical",
			Message:   fmt.Sprintf("%s (%s job) is in an errored state", job.Name, job.Source),
			Since:     time.Now().Format(time.RFC3339),
		})
	}
	return anomalies
}

// isBadServiceStatus flags only states that indicate active instability.
// "stopped" is deliberately excluded: a container the user stopped on
// purpose is not an incident, and there is no way to tell the two apart
// from Status alone — treating every stopped container as "degraded" would
// flood Overview with noise for completely normal, intentional state.
func isBadServiceStatus(status string) bool {
	switch status {
	case "restarting", "unhealthy":
		return true
	default:
		return false
	}
}

const (
	restartLoopWindow    = 10 * time.Minute
	restartLoopThreshold = 3
	degradedMinDuration  = 5 * time.Minute
)

// detectAnomalies diffs the current scan against the previous one (held in
// a.scanState, in memory only) to flag services that are flapping (restart
// loop) or have been unhealthy for a while (degraded). State for services no
// longer discovered is dropped so memory does not grow unbounded.
func (a *App) detectAnomalies(services []Service) []Anomaly {
	a.scanMu.Lock()
	defer a.scanMu.Unlock()
	if a.scanState == nil {
		a.scanState = map[string]*serviceScanState{}
	}
	now := time.Now()
	cutoff := now.Add(-restartLoopWindow)
	seen := map[string]bool{}
	var anomalies []Anomaly
	for _, svc := range services {
		seen[svc.ID] = true
		state, ok := a.scanState[svc.ID]
		if !ok {
			state = &serviceScanState{}
			a.scanState[svc.ID] = state
		}
		bad := isBadServiceStatus(svc.Status)
		wasBad := isBadServiceStatus(state.lastStatus)
		if bad && !wasBad && state.lastStatus != "" {
			state.transitions = append(state.transitions, now)
		}
		if bad {
			if state.badSince.IsZero() {
				state.badSince = now
			}
		} else {
			state.badSince = time.Time{}
		}
		pruned := state.transitions[:0]
		for _, t := range state.transitions {
			if t.After(cutoff) {
				pruned = append(pruned, t)
			}
		}
		state.transitions = pruned
		state.lastStatus = svc.Status

		switch {
		case len(state.transitions) >= restartLoopThreshold:
			anomalies = append(anomalies, Anomaly{
				ServiceID: svc.ID,
				Name:      svc.Name,
				Project:   projectOrUnassigned(svc.Project),
				Kind:      "restart_loop",
				Severity:  "critical",
				Message:   fmt.Sprintf("%s restarted %d times in the last %d minutes", svc.Name, len(state.transitions), int(restartLoopWindow.Minutes())),
				Since:     state.transitions[0].Format(time.RFC3339),
			})
		case bad && !state.badSince.IsZero() && now.Sub(state.badSince) >= degradedMinDuration:
			anomalies = append(anomalies, Anomaly{
				ServiceID: svc.ID,
				Name:      svc.Name,
				Project:   projectOrUnassigned(svc.Project),
				Kind:      "degraded",
				Severity:  "warning",
				Message:   fmt.Sprintf("%s has been %s for over %d minutes", svc.Name, svc.Status, int(degradedMinDuration.Minutes())),
				Since:     state.badSince.Format(time.RFC3339),
			})
		}
	}
	for id := range a.scanState {
		if !seen[id] {
			delete(a.scanState, id)
		}
	}
	sort.Slice(anomalies, func(i, j int) bool { return anomalies[i].Severity < anomalies[j].Severity })
	return anomalies
}
