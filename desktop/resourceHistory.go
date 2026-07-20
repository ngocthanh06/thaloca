package main

import (
	"context"
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

// sampleResourceHistoryLoop periodically records a ResourceSample. Reads
// only CPU/memory/disk/network directly (the same collectors Resources()
// itself calls) rather than the full Resources() — a history point doesn't
// need Resources()'s process/lsof port scan, GPU, battery, or thermal reads
// (TopProcess is left blank here; nothing in the frontend renders it, and
// the Resources tab's own 5s poll while open still gets full Resources()
// data).
func (a *App) sampleResourceHistoryLoop() {
	ticker := time.NewTicker(resourceSampleInterval)
	defer ticker.Stop()
	a.sampleResourceHistory()
	for range ticker.C {
		a.sampleResourceHistory()
	}
}

func (a *App) sampleResourceHistory() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cpu := readCPUStats(ctx)
	mem := readMemoryStats(ctx)
	disks := readDiskStats(ctx)
	network := a.readNetworkStats(ctx)

	var diskPercent float64
	for _, d := range disks {
		if d.MountPoint == "/" {
			diskPercent = d.UsedPercent
			break
		}
	}
	var rx, tx float64
	for _, n := range network {
		rx += n.RxBytesPerSec
		tx += n.TxBytesPerSec
	}

	sample := ResourceSample{
		At:               time.Now().Format(time.RFC3339),
		CPUPercent:       cpu.UserPercent + cpu.SystemPercent,
		MemPercent:       mem.UsedPercent,
		DiskPercent:      diskPercent,
		NetRxBytesPerSec: rx,
		NetTxBytesPerSec: tx,
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
	a.checkLocalResourceThreshold(sample)
}

// checkLocalResourceThreshold notifies when this Mac's own RAM or disk
// usage is under the same sustained pressure threshold already used for
// saved remote servers (see serverHealthThreshold in notifications.go).
func (a *App) checkLocalResourceThreshold(sample ResourceSample) {
	for _, pressure := range []struct {
		label   string
		percent float64
	}{
		{"RAM", sample.MemPercent},
		{"disk", sample.DiskPercent},
	} {
		high := pressure.percent >= float64(serverHealthThreshold)
		if !a.localPressureBecameHigh(pressure.label, high) {
			continue
		}
		message := fmt.Sprintf("This Mac's %s usage is at %.0f%%", pressure.label, pressure.percent)
		a.addEvent("health", "This Mac", "", "local", "local", "health_failed", message)
		a.notifyOnce("local-health:"+pressure.label, "health_failed", "Local resource usage high", message)
	}
}

func (a *App) localPressureBecameHigh(label string, high bool) bool {
	a.localPressureMu.Lock()
	defer a.localPressureMu.Unlock()
	if a.localPressure == nil {
		a.localPressure = map[string]bool{}
	}
	wasHigh := a.localPressure[label]
	a.localPressure[label] = high
	return high && !wasHigh
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

	// Compare the average of the first half of the window against the
	// second half, rather than just the two endpoints — a workload that
	// legitimately oscillates (e.g. 40%/80% every few minutes from normal
	// GC/cache behavior) can easily start near a trough and end near a
	// peak, which an endpoints-only check would misread as a sustained
	// climb. Two-half averages only flag a real, sustained shift.
	mid := len(recent) / 2
	var firstSum, secondSum float64
	for _, s := range recent[:mid] {
		firstSum += s.MemPercent
	}
	for _, s := range recent[mid:] {
		secondSum += s.MemPercent
	}
	firstAvg := firstSum / float64(mid)
	secondAvg := secondSum / float64(len(recent)-mid)

	if secondAvg-firstAvg >= growthThreshold {
		message := fmt.Sprintf("Memory usage averaged %.0f%% over the first half of the last %d minutes, %.0f%% over the second half", firstAvg, int(window.Minutes()), secondAvg)
		a.notifyOnce("memory-leak", "health_failed", "Possible memory leak", message)
	}
}
