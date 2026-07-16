package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// systemVPNEngine implements vpnEngine for VPNs the user has already
// configured in macOS System Settings (L2TP/IPsec, Cisco IPSec, IKEv2, …),
// driven through the built-in scutil. Unlike the WireGuard/OpenVPN engines
// it never needs administrator privileges — `scutil --nc start/stop` on a
// user-configured VPN runs as the normal user (macOS itself holds the
// credentials in the Keychain) — so none of the staging/hash-verification
// machinery applies here. Thaloca only links a server to an existing VPN
// service and toggles it; creating/editing the VPN itself stays in System
// Settings (see OpenSystemVPNSettings).
type systemVPNEngine struct{}

func (systemVPNEngine) kind() string { return "system" }
func (systemVPNEngine) name() string { return "System VPN" }

// binary is scutil, which ships with macOS — vpnEnginePrograms deliberately
// has no "system" entry, so vpnEngineInstalled reports this engine as
// always installed and no installSpecs/Homebrew flow ever applies to it.
func (systemVPNEngine) binary() string { return "scutil" }

// systemVPNService is one VPN configured in System Settings, as parsed
// from `scutil --nc list`.
type systemVPNService struct {
	ID   string
	Name string
	Type string // the bracketed service type, e.g. "PPP:L2TP", "VPN:IKEv2"
}

// systemVPNListLine matches enabled `scutil --nc list` lines such as
// `* (Disconnected) 5A735FE5-... PPP --> L2TP "concrete-vpn" [PPP:L2TP]`.
//
// Lines without the leading "*" are disabled services that scutil cannot
// start, so they are deliberately not offered.
var systemVPNListLine = regexp.MustCompile(`^\*\s*\((\w+)\)\s+([0-9A-Fa-f-]{36})\s+.*?"(.*)"\s+\[([^\]]+)\]\s*$`)

// listSystemVPNServices parses `scutil --nc list` into the enabled VPN
// services the picker can offer.
func listSystemVPNServices() ([]systemVPNService, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "scutil", "--nc", "list").Output()
	if err != nil {
		return nil, fmt.Errorf("scutil --nc list: %w", err)
	}
	return parseSystemVPNList(string(out)), nil
}

func parseSystemVPNList(out string) []systemVPNService {
	var services []systemVPNService
	for _, line := range strings.Split(out, "\n") {
		m := systemVPNListLine.FindStringSubmatch(strings.TrimRight(line, " \t\r"))
		if m == nil {
			continue
		}
		services = append(services, systemVPNService{ID: m[2], Name: m[3], Type: m[4]})
	}
	return services
}

// fields returns the single select field, its options rebuilt from
// `scutil --nc list` on every call — ListVPNEngines runs when the panel
// opens, so the picker always reflects what's currently configured in
// System Settings. A scutil failure is reported through OptionsError, so
// the frontend shows the real error rather than pretending no VPN exists;
// a genuinely empty list gets the Open VPN Settings guidance instead.
func (systemVPNEngine) fields() []VPNFieldDef {
	field := VPNFieldDef{
		Key:      "serviceID",
		Label:    "VPN configuration",
		Type:     "select",
		Required: true,
		Span:     "wide",
	}
	services, err := listSystemVPNServices()
	if err != nil {
		field.OptionsError = "Could not read the system's VPN list: " + err.Error()
		return []VPNFieldDef{field}
	}
	for _, s := range services {
		field.Options = append(field.Options, VPNFieldOption{Value: s.ID, Label: s.Name + " (" + s.Type + ")"})
	}
	return []VPNFieldDef{field}
}

// systemVPNConfig is what save() persists: the service ID scutil commands
// take, plus the human-readable name so error messages after the service
// was deleted/recreated in System Settings can still say which VPN this
// server pointed at. No secrets — those stay in macOS's own Keychain.
type systemVPNConfig struct {
	ServiceID string `json:"service_id"`
	Name      string `json:"name"`
}

func (e systemVPNEngine) confPath(serverID string) (string, error) {
	dir, err := vpnDir()
	if err != nil {
		return "", err
	}
	return dir + "/" + vpnFileBase(serverID) + ".sysvpn", nil
}

// save requires the chosen service ID to exist in the current
// `scutil --nc list` output — both to catch a stale picker and so the value
// later handed to scutil is always a known service ID, never free text.
func (e systemVPNEngine) save(serverID string, values map[string]string) error {
	serviceID := strings.TrimSpace(values["serviceID"])
	if serviceID == "" {
		return fmt.Errorf("choose a VPN configuration first")
	}
	services, err := listSystemVPNServices()
	if err != nil {
		return err
	}
	for _, s := range services {
		if s.ID == serviceID {
			dir, dirErr := vpnDir()
			if dirErr != nil {
				return dirErr
			}
			if mkErr := os.MkdirAll(dir, 0o700); mkErr != nil {
				return mkErr
			}
			path, pathErr := e.confPath(serverID)
			if pathErr != nil {
				return pathErr
			}
			data, marshalErr := json.Marshal(systemVPNConfig{ServiceID: s.ID, Name: s.Name})
			if marshalErr != nil {
				return marshalErr
			}
			return os.WriteFile(path, data, 0o600)
		}
	}
	return fmt.Errorf("that VPN no longer exists in System Settings — refresh and choose again")
}

func (e systemVPNEngine) loadConfig(serverID string) (systemVPNConfig, error) {
	path, err := e.confPath(serverID)
	if err != nil {
		return systemVPNConfig{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return systemVPNConfig{}, fmt.Errorf("no VPN config saved for this server yet")
	}
	var cfg systemVPNConfig
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.ServiceID == "" {
		return systemVPNConfig{}, fmt.Errorf("this server's System VPN config is corrupted — save it again")
	}
	return cfg, nil
}

func (e systemVPNEngine) configured(serverID string) bool {
	_, err := e.loadConfig(serverID)
	return err == nil
}

// systemVPNStatus returns the first line of `scutil --nc status` for a
// service — "Connected", "Disconnected", "Connecting", … — or an error when
// the service doesn't exist anymore.
func systemVPNStatus(serviceID string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "scutil", "--nc", "status", serviceID).Output()
	if err != nil {
		return "", fmt.Errorf("scutil --nc status: %w", err)
	}
	return parseSystemVPNStatus(string(out)), nil
}

func parseSystemVPNStatus(out string) string {
	first, _, _ := strings.Cut(out, "\n")
	return strings.TrimSpace(first)
}

func (e systemVPNEngine) connected(serverID string) bool {
	cfg, err := e.loadConfig(serverID)
	if err != nil {
		return false
	}
	status, err := systemVPNStatus(cfg.ServiceID)
	return err == nil && status == "Connected"
}

// connect starts the linked system VPN and polls until macOS reports it
// Connected — `scutil --nc start` returns immediately, well before the
// tunnel is up (the same reason the OpenVPN engine polls its log). A
// Disconnected status seen after the attempt started means macOS gave up
// (wrong credentials/unreachable server); that's reported as a failure
// pointing at System Settings, where the VPN's own configuration lives.
// Note the tunnel is system-wide, not per-server: connecting affects the
// whole Mac, and other Thaloca servers linked to the same service will
// show Connected too.
func (e systemVPNEngine) connect(serverID string) error {
	cfg, err := e.loadConfig(serverID)
	if err != nil {
		return err
	}
	if status, statusErr := systemVPNStatus(cfg.ServiceID); statusErr != nil {
		return fmt.Errorf("VPN %q no longer exists in System Settings — save this server's VPN config again", cfg.Name)
	} else if status == "Connected" {
		return nil
	}
	// Do not use `scutil --nc start` here. Apple's scutil implementation
	// always supplies empty PPP/IPSec user-options dictionaries, even when
	// no --user/--password/--secret flags were given. For L2TP that can
	// override the saved user preferences and make pppd see an incorrect
	// shared secret, while starting the same service from System Settings
	// succeeds. The native bridge passes NULL userOptions, which is the
	// documented way to use the service's saved default configuration.
	if startErr := startSystemVPN(cfg.ServiceID); startErr != nil {
		return fmt.Errorf("start System VPN: %w", startErr)
	}
	sawAttempt := false
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		status, statusErr := systemVPNStatus(cfg.ServiceID)
		if statusErr != nil {
			return statusErr
		}
		switch status {
		case "Connected":
			return nil
		case "Disconnected":
			if sawAttempt {
				return fmt.Errorf("VPN %q failed to connect — check its server address and credentials in System Settings", cfg.Name)
			}
		default:
			// Connecting/Authenticating/…: the attempt is genuinely underway.
			sawAttempt = true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("VPN %q hasn't finished connecting yet — check its status again shortly", cfg.Name)
}

// disconnect stops the linked system VPN. The tunnel is system-wide: if
// several Thaloca servers link to the same VPN service, stopping it here
// stops it for all of them (there is no per-server half of a system
// tunnel) — their status panels all just report Disconnected afterwards.
func (e systemVPNEngine) disconnect(serverID string) error {
	cfg, err := e.loadConfig(serverID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, stopErr := exec.CommandContext(ctx, "scutil", "--nc", "stop", cfg.ServiceID).CombinedOutput(); stopErr != nil {
		return fmt.Errorf("scutil --nc stop: %s", combinedOutputTail(out, stopErr))
	}
	return nil
}

// systemVPNSharedWith returns the names of every OTHER server linked to
// the same system VPN service as serverID — the tunnel is Mac-wide, so
// disconnecting it here also "disconnects" them; ServerVPNStatus exposes
// this so the frontend can warn before doing that.
func systemVPNSharedWith(serverID string) []string {
	cfg, err := systemVPNEngine{}.loadConfig(serverID)
	if err != nil {
		return nil
	}
	var shared []string
	for _, s := range loadServers() {
		if s.ID == serverID || s.VPNType != "system" {
			continue
		}
		other, otherErr := systemVPNEngine{}.loadConfig(s.ID)
		if otherErr == nil && other.ServiceID == cfg.ServiceID {
			shared = append(shared, s.Name)
		}
	}
	return shared
}

// OpenSystemVPNSettings opens macOS's network settings, where system VPNs
// are created and edited — offered by the frontend when the System VPN
// picker finds no configured VPNs. The deep link works on Ventura and
// later; the prefPane path is the fallback for older systems.
func (a *App) OpenSystemVPNSettings() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "open", "x-apple.systempreferences:com.apple.Network-Settings.extension").Run(); err == nil {
		return nil
	}
	return exec.CommandContext(ctx, "open", "/System/Library/PreferencePanes/Network.prefPane").Run()
}
