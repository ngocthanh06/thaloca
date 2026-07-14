package main

import (
	"context"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"sync"

	"thaloca.local/thaloca/internal/discovery"
)

// discoverAll returns every discovered service plus a Docker status message
// — empty when Docker was reached fine (regardless of how many containers
// it has), non-empty when the CLI is missing or the daemon/context couldn't
// be reached, so the UI can tell "genuinely zero containers" apart from
// "Docker/OrbStack isn't actually running" instead of showing an identical
// empty list for both.
func discoverAll(ctx context.Context) ([]Service, string) {
	var wg sync.WaitGroup
	results := make(chan []Service, 3)
	var dockerStatus string

	wg.Add(1)
	go func() {
		defer wg.Done()
		if _, err := exec.LookPath("docker"); err != nil {
			dockerStatus = "Docker CLI not found — install Docker Desktop or OrbStack."
			results <- nil
			return
		}
		svcs, contextStatuses, err := discovery.ScanDocker(ctx)
		if err != nil {
			dockerStatus = "Docker not reachable: " + discovery.DockerErrorDetail(err)
		} else if len(contextStatuses) > 0 {
			// Some contexts merged in fine (svcs isn't empty/all-failed —
			// that's the err != nil case above) but at least one couldn't be
			// reached — surface which, without hiding the containers that
			// did come through.
			parts := make([]string, len(contextStatuses))
			for i, s := range contextStatuses {
				parts[i] = s.Context + ": " + s.Error
			}
			dockerStatus = "Some Docker contexts not reachable — " + strings.Join(parts, "; ")
		}
		results <- svcs
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		svcs, _ := discovery.ScanProcesses(ctx)
		results <- svcs
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		svcs, _ := discovery.ScanGitRepos(ctx, discovery.GitSearchRoots())
		results <- svcs
	}()

	wg.Wait()
	close(results)

	var all []Service
	for svcs := range results {
		all = append(all, svcs...)
	}

	return discovery.Deduplicate(all), dockerStatus
}

func discoverPorts(ctx context.Context) []PortUsage {
	var ports []PortUsage
	dockerServices, _, _ := discovery.ScanDocker(ctx)
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
