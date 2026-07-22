package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"thaloca.local/thaloca/internal/discovery"
)

func (a *App) ListVolumes() ([]discovery.DockerVolume, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return discovery.ScanVolumes(ctx)
}

func (a *App) ListNetworks() ([]discovery.DockerNetwork, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return discovery.ScanNetworks(ctx)
}

func (a *App) ListImages() ([]discovery.DockerImage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return discovery.ScanImages(ctx)
}

// dockerContextArgs prepends --context engine (skipped when empty) so a
// remove targets the same Docker context the item was listed from — the
// list itself merges every context (see ScanVolumes/ScanNetworks/
// ScanImages), so a plain `docker ... rm` without this would fail with
// "no such volume/network/image" whenever that item isn't on whichever
// context happens to be currently active.
func dockerContextArgs(engine string, extra ...string) []string {
	args := make([]string, 0, len(extra)+2)
	if engine != "" {
		args = append(args, "--context", engine)
	}
	return append(args, extra...)
}

func (a *App) RemoveVolume(name, engine string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("volume name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", dockerContextArgs(engine, "volume", "rm", name)...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("docker volume rm: %s", message)
	}
	a.addEvent("action", "volume "+name, "", "volume", name, "removed", "Volume "+name+" removed")
	return nil
}

func (a *App) RemoveNetwork(id, engine string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("network id is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", dockerContextArgs(engine, "network", "rm", id)...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("docker network rm: %s", message)
	}
	a.addEvent("action", "network "+id, "", "network", id, "removed", "Network "+id+" removed")
	return nil
}

func (a *App) RemoveImage(id, engine string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("image id is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "docker", dockerContextArgs(engine, "image", "rm", id)...).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("docker image rm: %s", message)
	}
	a.addEvent("action", "image "+id, "", "image", id, "removed", "Image "+id+" removed")
	return nil
}
