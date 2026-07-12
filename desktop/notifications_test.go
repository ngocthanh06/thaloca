package main

import (
	"testing"
	"time"
)

func TestIsQuietHoursSameDayRange(t *testing.T) {
	settings := NotificationSettings{QuietHoursStart: "22:00", QuietHoursEnd: "23:30"}
	inside := time.Date(2026, 1, 1, 22, 30, 0, 0, time.UTC)
	before := time.Date(2026, 1, 1, 21, 59, 0, 0, time.UTC)
	after := time.Date(2026, 1, 1, 23, 31, 0, 0, time.UTC)
	if !isQuietHours(settings, inside) {
		t.Error("expected 22:30 to be inside 22:00-23:30 quiet hours")
	}
	if isQuietHours(settings, before) {
		t.Error("expected 21:59 to be outside 22:00-23:30 quiet hours")
	}
	if isQuietHours(settings, after) {
		t.Error("expected 23:31 to be outside 22:00-23:30 quiet hours")
	}
}

func TestIsQuietHoursCrossesMidnight(t *testing.T) {
	settings := NotificationSettings{QuietHoursStart: "22:00", QuietHoursEnd: "08:00"}
	lateNight := time.Date(2026, 1, 1, 23, 0, 0, 0, time.UTC)
	earlyMorning := time.Date(2026, 1, 1, 6, 0, 0, 0, time.UTC)
	midday := time.Date(2026, 1, 1, 13, 0, 0, 0, time.UTC)
	if !isQuietHours(settings, lateNight) {
		t.Error("expected 23:00 to be inside 22:00-08:00 (crosses midnight) quiet hours")
	}
	if !isQuietHours(settings, earlyMorning) {
		t.Error("expected 06:00 to be inside 22:00-08:00 (crosses midnight) quiet hours")
	}
	if isQuietHours(settings, midday) {
		t.Error("expected 13:00 to be outside 22:00-08:00 quiet hours")
	}
}

func TestIsQuietHoursDisabledWhenUnset(t *testing.T) {
	settings := NotificationSettings{}
	if isQuietHours(settings, time.Now()) {
		t.Error("expected no quiet hours configured to never be quiet")
	}
	settings = NotificationSettings{QuietHoursStart: "not-a-time", QuietHoursEnd: "08:00"}
	if isQuietHours(settings, time.Now()) {
		t.Error("expected an invalid quiet-hours value to be treated as disabled, not crash or misbehave")
	}
}

func TestEventTypeEnabled(t *testing.T) {
	settings := NotificationSettings{
		ContainerStopped:   true,
		HealthFailed:       false,
		JobErrored:         true,
		ServerDisconnected: false,
		UpdateAvailable:    true,
	}
	cases := map[string]bool{
		"container_stopped":   true,
		"health_failed":       false,
		"job_errored":         true,
		"server_disconnected": false,
		"update_available":    true,
		"unknown_type":        false,
	}
	for eventType, want := range cases {
		if got := eventTypeEnabled(settings, eventType); got != want {
			t.Errorf("eventTypeEnabled(%q) = %v, want %v", eventType, got, want)
		}
	}
}

func TestNotificationSettingsRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	// No file yet — must return sane defaults, not zero-value-everything-off.
	defaults := loadNotificationSettings()
	if !defaults.Enabled || !defaults.ContainerStopped || !defaults.HealthFailed || !defaults.JobErrored || !defaults.ServerDisconnected || !defaults.UpdateAvailable {
		t.Fatalf("expected all-enabled defaults when no settings file exists, got %+v", defaults)
	}

	custom := NotificationSettings{
		Enabled:            true,
		ContainerStopped:   false,
		HealthFailed:       true,
		JobErrored:         false,
		ServerDisconnected: true,
		UpdateAvailable:    false,
		QuietHoursStart:    "21:00",
		QuietHoursEnd:      "07:00",
	}
	if err := saveNotificationSettings(custom); err != nil {
		t.Fatalf("saveNotificationSettings: %v", err)
	}
	loaded := loadNotificationSettings()
	if loaded != custom {
		t.Errorf("loaded settings %+v do not match saved settings %+v", loaded, custom)
	}
}
