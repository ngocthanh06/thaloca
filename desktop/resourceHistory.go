package main

import (
	"fmt"
	"time"
)

// ResourceSample is one point-in-time reading kept for the Resources tab's
// history charts. Sampled independently of the tab being open (see
// App.sampleResourceHistoryLoop), so a real 24h history exists whenever
// it's visited.
type ResourceSample struct {
	At               string  `json:"at"`
	CPUPercent       float64 `json:"cpu_percent"`
	MemPercent       float64 `json:"mem_percent"`
	DiskPercent      float64 `json:"disk_percent"`
	NetRxBytesPerSec float64 `json:"net_rx_bytes_per_sec"`
	NetTxBytesPerSec float64 `json:"net_tx_bytes_per_sec"`
	TopProcess       string  `json:"top_process,omitempty"`
}

const (
	resourceSampleInterval = 60 * time.Second
	resourceHistoryMaxAge  = 24 * time.Hour
)

// sampleResourceHistoryLoop periodically records a ResourceSample. Reuses
// Resources() (the same read the tab itself polls) rather than duplicating
// CPU/memory/disk/network collection — at one sample per minute this is a
// small fraction of the cost Resources() already pays every 5s while the
// tab is open.
func (a *App) sampleResourceHistoryLoop() {
	ticker := time.NewTicker(resourceSampleInterval)
	defer ticker.Stop()
	a.sampleResourceHistory()
	for range ticker.C {
		a.sampleResourceHistory()
	}
}

func (a *App) sampleResourceHistory() {
	snapshot := a.Resources()

	var diskPercent float64
	for _, d := range snapshot.Disks {
		if d.MountPoint == "/" {
			diskPercent = d.UsedPercent
			break
		}
	}
	var rx, tx float64
	for _, n := range snapshot.Network {
		rx += n.RxBytesPerSec
		tx += n.TxBytesPerSec
	}
	var topProcess string
	if len(snapshot.Processes) > 0 {
		topProcess = snapshot.Processes[0].Command
	}

	sample := ResourceSample{
		At:               time.Now().Format(time.RFC3339),
		CPUPercent:       snapshot.CPU.UserPercent + snapshot.CPU.SystemPercent,
		MemPercent:       snapshot.Memory.UsedPercent,
		DiskPercent:      diskPercent,
		NetRxBytesPerSec: rx,
		NetTxBytesPerSec: tx,
		TopProcess:       topProcess,
	}

	a.resourceHistoryMu.Lock()
	a.resourceHistory = append(a.resourceHistory, sample)
	cutoff := time.Now().Add(-resourceHistoryMaxAge)
	pruned := a.resourceHistory[:0]
	for _, s := range a.resourceHistory {
		t, err := time.Parse(time.RFC3339, s.At)
		if err == nil && t.Before(cutoff) {
			continue
		}
		pruned = append(pruned, s)
	}
	a.resourceHistory = pruned
	a.resourceHistoryMu.Unlock()

	a.checkMemoryLeak()
}

// ResourceHistory returns sampled history for the requested window
// ("15m", "1h", or "24h" — anything else defaults to "1h").
func (a *App) ResourceHistory(window string) []ResourceSample {
	var duration time.Duration
	switch window {
	case "15m":
		duration = 15 * time.Minute
	case "24h":
		duration = 24 * time.Hour
	default:
		duration = time.Hour
	}
	cutoff := time.Now().Add(-duration)

	a.resourceHistoryMu.Lock()
	defer a.resourceHistoryMu.Unlock()
	result := []ResourceSample{}
	for _, s := range a.resourceHistory {
		t, err := time.Parse(time.RFC3339, s.At)
		if err == nil && t.Before(cutoff) {
			continue
		}
		result = append(result, s)
	}
	return result
}

// checkMemoryLeak flags a sustained climb in memory usage over a trailing
// window (grown by at least growthThreshold points and never meaningfully
// dropped back down) — a rough proxy for "this looks like a leak" rather
// than a normal, temporary spike.
func (a *App) checkMemoryLeak() {
	const window = 30 * time.Minute
	const minSamples = 6
	const growthThreshold = 15.0

	a.resourceHistoryMu.Lock()
	history := make([]ResourceSample, len(a.resourceHistory))
	copy(history, a.resourceHistory)
	a.resourceHistoryMu.Unlock()

	cutoff := time.Now().Add(-window)
	var recent []ResourceSample
	for _, s := range history {
		t, err := time.Parse(time.RFC3339, s.At)
		if err == nil && !t.Before(cutoff) {
			recent = append(recent, s)
		}
	}
	if len(recent) < minSamples {
		return
	}

	first := recent[0].MemPercent
	last := recent[len(recent)-1].MemPercent
	minInBetween := first
	for _, s := range recent {
		if s.MemPercent < minInBetween {
			minInBetween = s.MemPercent
		}
	}
	if last-first >= growthThreshold && minInBetween >= first-3 {
		message := fmt.Sprintf("Memory usage climbed from %.0f%% to %.0f%% over the last %d minutes without dropping back", first, last, int(window.Minutes()))
		a.notifyOnce("memory-leak", "health_failed", "Possible memory leak", message)
	}
}
