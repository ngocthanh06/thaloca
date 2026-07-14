package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// RuntimeEngineStatus reports one container engine's presence on this
// machine (Docker Desktop, OrbStack, or Colima) — installed and,
// separately, actually running (its docker context answers).
type RuntimeEngineStatus struct {
	Kind        string `json:"kind"` // "docker-desktop" | "orbstack" | "colima"
	Name        string `json:"name"`
	DownloadURL string `json:"download_url,omitempty"`
	Installed   bool   `json:"installed"`
	Running     bool   `json:"running"`
}

// ContainerRuntimeStatus is the full picture the Runtime view's engine
// card needs.
type ContainerRuntimeStatus struct {
	Engines []RuntimeEngineStatus `json:"engines"`
	// MultipleRunning is true when more than one engine answers at once —
	// Docker Desktop and OrbStack both claim /var/run/docker.sock, so
	// running both together means one is silently not the one actually in
	// effect. Informational here; StartContainerRuntime is what actually
	// refuses to make this worse.
	MultipleRunning bool `json:"multiple_running"`
	// HomebrewAvailable gates whether "Install Colima" can offer to run
	// `brew install` itself, versus just pointing the user at installing
	// Homebrew first.
	HomebrewAvailable bool `json:"homebrew_available"`
}

// containerRuntimeDefs is every engine Thaloca knows how to detect and
// start/stop, each identified by the docker context name it registers
// itself under (same names already used for context fallback resolution
// elsewhere — see internal/discovery).
var containerRuntimeDefs = []struct {
	kind        string
	name        string
	appPath     string // "" for Colima, which isn't a macOS .app
	contextName string
	downloadURL string
}{
	{"docker-desktop", "Docker Desktop", "/Applications/Docker.app", "desktop-linux", "https://www.docker.com/products/docker-desktop/"},
	{"orbstack", "OrbStack", "/Applications/OrbStack.app", "orbstack", "https://orbstack.dev/download"},
	{"colima", "Colima", "", "colima", ""},
}

func runtimeEngineDef(kind string) (name, appPath, contextName string, ok bool) {
	for _, def := range containerRuntimeDefs {
		if def.kind == kind {
			return def.name, def.appPath, def.contextName, true
		}
	}
	return "", "", "", false
}

func isAppBundleInstalled(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// contextReachable reports whether `docker --context <name>` can reach a
// live daemon, bounded by a short timeout — a stopped engine's socket
// fails to connect almost instantly, so this stays fast even when
// checking all three engines back to back.
func contextReachable(contextName string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, "docker", "--context", contextName, "info", "--format", "{{.ID}}").Run()
	return err == nil
}

// GetContainerRuntimeStatus reports every known engine's install/running
// state, on demand (not polled continuously — each check shells out to
// `docker`, cheap but not free).
func (a *App) GetContainerRuntimeStatus() ContainerRuntimeStatus {
	engines := make([]RuntimeEngineStatus, len(containerRuntimeDefs))
	var wg sync.WaitGroup
	for i := range containerRuntimeDefs {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			def := containerRuntimeDefs[i]
			installed := false
			if def.kind == "colima" {
				_, err := exec.LookPath("colima")
				installed = err == nil
			} else {
				installed = isAppBundleInstalled(def.appPath)
			}
			engines[i] = RuntimeEngineStatus{
				Kind:        def.kind,
				Name:        def.name,
				DownloadURL: def.downloadURL,
				Installed:   installed,
				Running:     installed && contextReachable(def.contextName),
			}
		}()
	}
	wg.Wait()
	running := 0
	for _, engine := range engines {
		if engine.Running {
			running++
		}
	}
	_, brewErr := exec.LookPath("brew")
	return ContainerRuntimeStatus{
		Engines:           engines,
		MultipleRunning:   running > 1,
		HomebrewAvailable: brewErr == nil,
	}
}

// StartContainerRuntime starts the given engine ("docker-desktop",
// "orbstack", or "colima"). Refuses to start a different engine while
// another is already running: Docker Desktop and OrbStack both take over
// /var/run/docker.sock, so running two at once means one silently isn't
// the one actually in effect rather than both working side by side.
// Starting the engine that's already running is a no-op success.
func (a *App) StartContainerRuntime(kind string) error {
	name, appPath, _, ok := runtimeEngineDef(kind)
	if !ok {
		return fmt.Errorf("unknown container runtime %q", kind)
	}

	status := a.GetContainerRuntimeStatus()
	for _, e := range status.Engines {
		if e.Kind == kind && e.Running {
			return nil
		}
		if e.Kind != kind && e.Running {
			return fmt.Errorf("%s is already running — stop it first, since running two engines at once means they fight over the same Docker socket", e.Name)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if kind == "colima" {
		// colima start blocks until the VM is actually up, unlike `open
		// -a` for the GUI engines below — give it a generous timeout
		// since a cold start (or first-run VM image fetch) can take
		// well past 10s.
		colimaCtx, colimaCancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer colimaCancel()
		if out, err := exec.CommandContext(colimaCtx, "colima", "start").CombinedOutput(); err != nil {
			return fmt.Errorf("colima start: %s", combinedOutputTail(out, err))
		}
		return nil
	}

	if !isAppBundleInstalled(appPath) {
		return fmt.Errorf("%s isn't installed at %s", name, appPath)
	}
	if err := exec.CommandContext(ctx, "open", "-a", appPath).Run(); err != nil {
		return fmt.Errorf("opening %s: %w", name, err)
	}
	return nil
}

// StopContainerRuntime stops the given engine. Docker Desktop and OrbStack
// are quit like any other macOS app (AppleScript "quit", same mechanism
// Thaloca's own background-on-close behavior relies on); Colima has its
// own CLI for this.
func (a *App) StopContainerRuntime(kind string) error {
	name, _, _, ok := runtimeEngineDef(kind)
	if !ok {
		return fmt.Errorf("unknown container runtime %q", kind)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if kind == "colima" {
		if out, err := exec.CommandContext(ctx, "colima", "stop").CombinedOutput(); err != nil {
			return fmt.Errorf("colima stop: %s", combinedOutputTail(out, err))
		}
		return nil
	}

	script := fmt.Sprintf(`tell application %q to quit`, name)
	if err := exec.CommandContext(ctx, "osascript", "-e", script).Run(); err != nil {
		return fmt.Errorf("quitting %s: %w", name, err)
	}
	return nil
}

// InstallColima installs Colima plus the Docker CLI, Compose, and Buildx
// plugins via Homebrew — the only engine Thaloca offers to install itself,
// since it's fully open source (MIT) with no licensing distinction
// between personal and commercial use, unlike OrbStack. Does not start it
// afterwards; the Runtime view calls StartContainerRuntime("colima")
// separately once this succeeds, so the UI can show installing/starting
// as distinct steps.
func (a *App) InstallColima() error {
	if _, err := exec.LookPath("brew"); err != nil {
		return fmt.Errorf("Homebrew isn't installed — install it from https://brew.sh first, then try again")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, "brew", "install", "colima", "docker", "docker-compose", "docker-buildx").CombinedOutput()
	if err != nil {
		return fmt.Errorf("brew install: %s", combinedOutputTail(out, err))
	}
	return nil
}

// combinedOutputTail keeps error messages from a failed CombinedOutput()
// call readable — brew/colima can print many lines of progress output,
// only the last few of which usually explain a failure.
func combinedOutputTail(out []byte, err error) string {
	const maxLines = 8
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return err.Error()
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n")
}
