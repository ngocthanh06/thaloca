package main

import (
	"context"
	"runtime"
	"sort"
	"sync"

	"thaloca.local/thaloca/internal/discovery"
)

func discoverAll(ctx context.Context) []Service {
	var wg sync.WaitGroup
	results := make(chan []Service, 3)

	wg.Add(1)
	go func() {
		defer wg.Done()
		svcs, _ := discovery.ScanDocker(ctx)
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

	return discovery.Deduplicate(all)
}

func discoverPorts(ctx context.Context) []PortUsage {
	var ports []PortUsage
	dockerServices, _ := discovery.ScanDocker(ctx)
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
