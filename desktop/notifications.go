package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NotificationSettings controls which events trigger a native macOS
// notification (see App.Notify) and when they're silenced. Purely local
// preferences — never affects what's detected, only whether/when the user
// is interrupted about it.
type NotificationSettings struct {
	Enabled            bool   `json:"enabled"`
	ContainerStopped   bool   `json:"container_stopped"`
	HealthFailed       bool   `json:"health_failed"`
	JobErrored         bool   `json:"job_errored"`
	ServerDisconnected bool   `json:"server_disconnected"`
	UpdateAvailable    bool   `json:"update_available"`
	QuietHoursStart    string `json:"quiet_hours_start,omitempty"` // "HH:MM", 24h, empty = no quiet hours
	QuietHoursEnd      string `json:"quiet_hours_end,omitempty"`
}

func defaultNotificationSettings() NotificationSettings {
	return NotificationSettings{
		Enabled:            true,
		ContainerStopped:   true,
		HealthFailed:       true,
		JobErrored:         true,
		ServerDisconnected: true,
		UpdateAvailable:    true,
	}
}

func notificationSettingsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "notifications.json"), nil
}

func loadNotificationSettings() NotificationSettings {
	path, err := notificationSettingsPath()
	if err != nil {
		return defaultNotificationSettings()
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return defaultNotificationSettings()
	}
	settings := defaultNotificationSettings()
	if err := json.Unmarshal(data, &settings); err != nil {
		return defaultNotificationSettings()
	}
	return settings
}

func saveNotificationSettings(settings NotificationSettings) error {
	path, err := notificationSettingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// GetNotificationSettings returns the current notification preferences.
func (a *App) GetNotificationSettings() NotificationSettings {
	return loadNotificationSettings()
}

// SetNotificationSettings persists new notification preferences.
func (a *App) SetNotificationSettings(settings NotificationSettings) error {
	return saveNotificationSettings(settings)
}

// isQuietHours reports whether `now` falls in the configured quiet window,
// handling ranges that cross midnight (e.g. 22:00-08:00).
func isQuietHours(settings NotificationSettings, now time.Time) bool {
	start, ok1 := parseClockTime(settings.QuietHoursStart)
	end, ok2 := parseClockTime(settings.QuietHoursEnd)
	if !ok1 || !ok2 {
		return false
	}
	cur := now.Hour()*60 + now.Minute()
	if start == end {
		return false
	}
	if start < end {
		return cur >= start && cur < end
	}
	// Crosses midnight, e.g. 22:00-08:00.
	return cur >= start || cur < end
}

// parseClockTime parses "HH:MM" into minutes-since-midnight.
func parseClockTime(s string) (int, bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, false
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

// notifyCooldown bounds how often the same (key) can re-notify — an
// ongoing anomaly (e.g. a container stuck restarting) is detected on every
// Snapshot() poll, but the user only needs to hear about it once in a
// while, not every few seconds.
const notifyCooldown = 15 * time.Minute

// notifyOnce sends a native notification for `key` (a stable identifier
// for "this specific ongoing problem") at most once per notifyCooldown,
// and only if settings/quiet-hours allow eventType.
func (a *App) notifyOnce(key, eventType, title, message string) {
	settings := loadNotificationSettings()
	if !settings.Enabled || !eventTypeEnabled(settings, eventType) || isQuietHours(settings, time.Now()) {
		return
	}

	a.notifyMu.Lock()
	if a.notifyLast == nil {
		a.notifyLast = map[string]time.Time{}
	}
	now := time.Now()
	if last, seen := a.notifyLast[key]; seen && now.Sub(last) < notifyCooldown {
		a.notifyMu.Unlock()
		return
	}
	a.notifyLast[key] = now
	// Opportunistically drop long-stale keys (a container/server/health URL
	// that hasn't had a problem in a day isn't worth remembering a cooldown
	// for) — otherwise this map would grow for as long as the app keeps
	// running in the background, one entry per distinct problem ever seen.
	for k, t := range a.notifyLast {
		if now.Sub(t) > 24*time.Hour {
			delete(a.notifyLast, k)
		}
	}
	a.notifyMu.Unlock()

	_ = a.Notify(title, message)
}

func eventTypeEnabled(settings NotificationSettings, eventType string) bool {
	switch eventType {
	case "container_stopped":
		return settings.ContainerStopped
	case "health_failed":
		return settings.HealthFailed
	case "job_errored":
		return settings.JobErrored
	case "server_disconnected":
		return settings.ServerDisconnected
	case "update_available":
		return settings.UpdateAvailable
	default:
		return false
	}
}

// notifyAnomalies pushes a native notification for freshly-detected
// container/job problems. restart_loop maps to "container stopped" (a
// container stuck restarting is, from the user's perspective, a container
// that keeps stopping) and job_failed maps to "job errored"; "degraded" and
// "log_error" anomalies are already visible in Overview's anomaly strip and
// don't also push a notification, to avoid duplicate noise.
func (a *App) notifyAnomalies(anomalies []Anomaly) {
	for _, an := range anomalies {
		switch an.Kind {
		case "restart_loop":
			a.notifyOnce("anomaly:"+an.ServiceID+":"+an.Kind, "container_stopped", "Container restarting repeatedly", an.Message)
		case "job_failed":
			a.notifyOnce("anomaly:"+an.ServiceID+":"+an.Kind, "job_errored", "Job errored", an.Message)
		}
	}
}

// pollServerReachability periodically re-checks every saved server's SSH
// reachability in the background (independent of whether the Servers tab
// is open), so a server going offline can be noticed and notified about.
func (a *App) pollServerReachability() {
	ticker := time.NewTicker(3 * time.Minute)
	defer ticker.Stop()
	a.checkServerReachability()
	for range ticker.C {
		a.checkServerReachability()
	}
}

func (a *App) checkServerReachability() {
	servers := loadServers()
	if len(servers) == 0 {
		return
	}

	current := make(map[string]bool, len(servers))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, conn := range servers {
		wg.Add(1)
		go func(conn ServerConnection) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			args := append(sshBaseArgs(conn), "exit")
			err := exec.CommandContext(ctx, "ssh", args...).Run()
			mu.Lock()
			current[conn.ID] = err == nil
			mu.Unlock()
		}(conn)
	}
	wg.Wait()

	a.serverReachMu.Lock()
	baselined := a.serverReachBaselined
	previous := a.serverReachable
	a.serverReachable = current
	a.serverReachBaselined = true
	a.serverReachMu.Unlock()

	if !baselined {
		return
	}
	for _, conn := range servers {
		was, existed := previous[conn.ID]
		if !existed || !was || current[conn.ID] {
			continue
		}
		message := fmt.Sprintf("%s (%s@%s) is no longer reachable over SSH", conn.Name, conn.User, conn.Host)
		a.addEvent("health", conn.Name, "", "server", conn.ID, "server_disconnected", message)
		a.notifyOnce("server:"+conn.ID, "server_disconnected", "Server disconnected", message)
	}
}

// serverHealthThreshold is the CPU/memory/disk percent above which a saved
// server is considered under resource pressure worth notifying about.
const serverHealthThreshold = 90

// pollServerHealthLoop periodically runs the same diagnostic bundle as the
// Servers tab's on-demand "Check" button for every saved server, in the
// background, so sustained high CPU/memory/disk is noticed without the tab
// being open. Reachability itself is already covered by
// pollServerReachability — this only looks at resource pressure on servers
// that are currently reachable.
func (a *App) pollServerHealthLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	a.checkServerHealthThresholds()
	for range ticker.C {
		a.checkServerHealthThresholds()
	}
}

func (a *App) checkServerHealthThresholds() {
	for _, conn := range loadServers() {
		health := checkServerHealth(conn)
		if !health.Reachable {
			continue
		}
		for _, pressure := range []struct {
			label   string
			percent int
		}{
			{"CPU", health.CPUPercent},
			{"memory", health.MemPercent},
			{"disk", health.DiskPercent},
		} {
			if pressure.percent < serverHealthThreshold {
				continue
			}
			message := fmt.Sprintf("%s (%s@%s) %s usage is at %d%%", conn.Name, conn.User, conn.Host, pressure.label, pressure.percent)
			a.addEvent("health", conn.Name, "", "server", conn.ID, "health_failed", message)
			a.notifyOnce("server-health:"+conn.ID+":"+pressure.label, "health_failed", "Server resource usage high", message)
		}
	}
}
