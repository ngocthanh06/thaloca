package main

import (
	"fmt"
	"sort"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

// TimelineEvent is one entry in the in-memory activity timeline (container/
// process actions, health transitions, job discovery, port ownership
// changes). Like Overview/anomalies/health history, this is kept only for
// the current app session in a bounded ring buffer and is never persisted
// to disk — restarting the app clears it.
type TimelineEvent struct {
	ID         string `json:"id"`
	At         string `json:"at"`
	Category   string `json:"category"` // "runtime" | "health" | "action"
	Name       string `json:"name"`
	Project    string `json:"project,omitempty"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id,omitempty"`
	Kind       string `json:"kind"`
	Message    string `json:"message"`
}

const eventLogLimit = 200

// addEvent appends one entry to the in-memory timeline ring buffer, dropping
// the oldest entries once the cap is reached.
func (a *App) addEvent(category, name, project, targetType, targetID, kind, message string) {
	a.eventMu.Lock()
	defer a.eventMu.Unlock()
	a.events = append(a.events, TimelineEvent{
		ID:         fmt.Sprintf("evt:%d", time.Now().UnixNano()),
		At:         time.Now().Format(time.RFC3339Nano),
		Category:   category,
		Name:       name,
		Project:    project,
		TargetType: targetType,
		TargetID:   targetID,
		Kind:       kind,
		Message:    message,
	})
	if len(a.events) > eventLogLimit {
		a.events = a.events[len(a.events)-eventLogLimit:]
	}
}

// RecentEvents returns the in-memory runtime/health/action timeline, most
// recent first. Git commits/events are not included here — the frontend
// already has those via GetActivity() and merges them client-side.
func (a *App) RecentEvents(limit int) []TimelineEvent {
	a.eventMu.Lock()
	defer a.eventMu.Unlock()
	if limit <= 0 || limit > eventLogLimit {
		limit = eventLogLimit
	}
	result := make([]TimelineEvent, len(a.events))
	copy(result, a.events)
	sort.Slice(result, func(i, j int) bool { return result[i].At > result[j].At })
	if len(result) > limit {
		result = result[:limit]
	}
	return result
}

// diffJobEvents compares the current job scan against the previous one to
// record "discovered"/"exited" timeline events. The first scan only
// establishes the baseline — otherwise every job already running before the
// app started would be reported as newly discovered.
func (a *App) diffJobEvents(jobs []Job) {
	a.jobMu.Lock()
	defer a.jobMu.Unlock()
	seen := make(map[string]Job, len(jobs))
	for _, job := range jobs {
		seen[job.ID] = job
		if a.jobBaselined {
			if _, existed := a.jobSeen[job.ID]; !existed {
				a.addEvent("runtime", job.Name, job.Project, "job", job.ID, "job_discovered", fmt.Sprintf("%s discovered (%s)", job.Name, job.Source))
			}
		}
	}
	if a.jobBaselined {
		for id, job := range a.jobSeen {
			if _, stillThere := seen[id]; !stillThere {
				a.addEvent("runtime", job.Name, job.Project, "job", job.ID, "job_exited", fmt.Sprintf("%s exited (%s)", job.Name, job.Source))
			}
		}
	}
	a.jobSeen = seen
	a.jobBaselined = true
}

// diffPortEvents compares the current port scan against the previous one to
// record "port ownership changed" events for ports whose owner changes
// between scans. Baseline-gated the same way as diffJobEvents.
func (a *App) diffPortEvents(ports []PortUsage) {
	a.portMu.Lock()
	defer a.portMu.Unlock()
	current := make(map[int]string, len(ports))
	names := make(map[int]string, len(ports))
	for _, p := range ports {
		owner := p.Process
		if p.ContainerID != "" {
			owner = "container:" + discovery.ShortID(p.ContainerID)
		}
		current[p.Port] = owner
		if p.Name != "" {
			names[p.Port] = p.Name
		} else {
			names[p.Port] = owner
		}
	}
	if a.portBaselined {
		for port, owner := range current {
			if previous, existed := a.portOwner[port]; existed && previous != owner {
				a.addEvent("runtime", names[port], "", "port", fmt.Sprintf("%d", port), "port_changed",
					fmt.Sprintf("Port %d changed owner from %s to %s", port, previous, owner))
			}
		}
	}
	a.portOwner = current
	a.portBaselined = true
}
