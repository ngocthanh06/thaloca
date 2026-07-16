package main

import (
	"context"
	"os/exec"
	"runtime"
	"sort"
	"strings"

	"thaloca.local/thaloca/internal/discovery"
)

// discoverAll returns every discovered service plus a Docker status message
// — empty when Docker was reached fine (regardless of how many containers
// it has), non-empty when the CLI is missing or the daemon/context couldn't
// be reached, so the UI can tell "genuinely zero containers" apart from
// "Docker/OrbStack isn't actually running" instead of showing an identical
// empty list for both. dockerServices/dockerContextStatuses/dockerErr are
// Snapshot's single already-run discovery.ScanDocker result, and
// procServices its already-run discovery.ScanProcesses result — both passed
// in (Snapshot runs them in parallel under separate deadlines) rather than
// scanned again here. repoPaths are likewise Snapshot's already-cached repo
// list (see App.cachedRepoPaths) instead of a fresh filesystem walk on
// every call.
func discoverAll(repoPaths []string, procServices []discovery.Service, dockerServices []discovery.Service, dockerContextStatuses []discovery.DockerContextStatus, dockerErr error) ([]Service, string) {
	var dockerStatus string
	if _, err := exec.LookPath("docker"); err != nil {
		dockerStatus = "Docker CLI not found — install Docker Desktop or OrbStack."
		dockerServices = nil
	} else if dockerErr != nil {
		dockerStatus = "Docker not reachable: " + discovery.DockerErrorDetail(dockerErr)
	} else if len(dockerContextStatuses) > 0 {
		// Some contexts merged in fine (dockerServices isn't empty/all-failed
		// — that's the err != nil case above) but at least one couldn't be
		// reached — surface which, without hiding the containers that did
		// come through.
		parts := make([]string, len(dockerContextStatuses))
		for i, s := range dockerContextStatuses {
			parts[i] = s.Context + ": " + s.Error
		}
		dockerStatus = "Some Docker contexts not reachable — " + strings.Join(parts, "; ")
	}

	var all []Service
	all = append(all, dockerServices...)
	all = append(all, procServices...)
	all = append(all, discovery.ServicesFromRepoPaths(repoPaths)...)
	return discovery.Deduplicate(all), dockerStatus
}

func discoverPorts(ctx context.Context, dockerServices []discovery.Service) []PortUsage {
	var ports []PortUsage
	for _, svc := range dockerServices {
		for _, port := range svc.Ports {
			ports = append(ports, PortUsage{
				Port:        port,
				Protocol:    "tcp",
				Address:     "0.0.0.0",
				Process:     "docker",
				Source:      "docker",
				ContainerID: svc.ContainerID,
				Name:        svc.Name,
				Command:     svc.Command,
				Project:     svc.Project,
			})
		}
	}
	if runtime.GOOS == "darwin" {
		if listeners, err := discovery.NewDarwinScanner().Scan(ctx); err == nil {
			for _, listener := range listeners {
				if discovery.IsDockerProcess(listener.Process) {
					continue
				}
				ports = append(ports, PortUsage{
					Port:     listener.Port,
					Protocol: "tcp",
					Address:  listener.Address,
					Process:  listener.Process,
					PID:      listener.PID,
					Source:   "process",
					Name:     listener.Process,
				})
			}
		}
	}
	sort.Slice(ports, func(i, j int) bool {
		return ports[i].Port < ports[j].Port
	})
	return ports
}
