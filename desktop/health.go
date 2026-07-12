package main

import (
	"context"
	"fmt"
	"time"

	"thaloca.local/thaloca/internal/health"
)

// HealthSamplePoint is one point in a service's in-memory rolling health
// history (used for the Service Inspector sparkline). It is kept only for
// the current app session and is never persisted to disk.
type HealthSamplePoint struct {
	At      string `json:"at"`
	State   string `json:"state"`
	Latency int64  `json:"latency"`
}

// healthSample is one recorded CheckHealth result, kept in a bounded
// in-memory ring per health URL.
type healthSample struct {
	At      time.Time
	State   string
	Latency int64
}

var healthChecker = health.New()

// CheckHealth checks a single service's health endpoint
func (a *App) CheckHealth(healthURL string) HealthStatus {
	if healthURL == "" {
		return HealthStatus{State: "unknown", Message: "no health URL"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := healthStatusFromCheckResult(healthChecker.Check(ctx, healthURL))
	a.recordHealthSample(healthURL, result)
	return result
}

func healthStatusFromCheckResult(r health.CheckResult) HealthStatus {
	return HealthStatus{
		Name:       r.Name,
		Type:       r.Type,
		Target:     r.Target,
		State:      r.State,
		Message:    r.Message,
		Latency:    r.Latency,
		StatusCode: r.StatusCode,
		CheckedAt:  r.CheckedAt,
	}
}

// recordHealthSample appends one CheckHealth result to the in-memory rolling
// history for that health URL, capped at healthHistoryLimit points. The
// health URL is already a unique key per service, so no extra parameter is
// needed on CheckHealth to identify which service a sample belongs to.
const healthHistoryLimit = 40

func (a *App) recordHealthSample(healthURL string, result HealthStatus) {
	a.healthMu.Lock()
	if a.healthHistory == nil {
		a.healthHistory = map[string][]healthSample{}
	}
	previous := a.healthHistory[healthURL]
	var previousState string
	if len(previous) > 0 {
		previousState = previous[len(previous)-1].State
	}
	history := append(previous, healthSample{At: time.Now(), State: result.State, Latency: result.Latency})
	if len(history) > healthHistoryLimit {
		history = history[len(history)-healthHistoryLimit:]
	}
	a.healthHistory[healthURL] = history
	a.healthMu.Unlock()

	// Baseline-gated like diffJobEvents/diffPortEvents: only report a change,
	// not the first-ever health check for a service.
	if previousState != "" && previousState != result.State {
		a.addEvent("health", result.Name, "", "service", healthURL, "health_changed",
			fmt.Sprintf("%s changed from %s to %s", result.Name, previousState, result.State))
		if result.State == "down" {
			message := fmt.Sprintf("%s health check is failing", result.Name)
			a.notifyOnce("health:"+healthURL, "health_failed", "Health check failed", message)
		}
	}
}

// HealthHistory returns the in-memory rolling health samples recorded for a
// health URL during this app session (used by the Service Inspector
// sparkline). Empty until CheckHealth has been called for that URL at least
// once; never persisted to disk.
func (a *App) HealthHistory(healthURL string) []HealthSamplePoint {
	a.healthMu.Lock()
	defer a.healthMu.Unlock()
	samples := a.healthHistory[healthURL]
	points := make([]HealthSamplePoint, len(samples))
	for i, s := range samples {
		points[i] = HealthSamplePoint{At: s.At.Format(time.RFC3339), State: s.State, Latency: s.Latency}
	}
	return points
}
