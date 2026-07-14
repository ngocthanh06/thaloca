package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"thaloca.local/thaloca/internal/health"
)

// Service is a discoverable unit on the local machine: a Docker container, a
// local process listening on a TCP port, or a git repository. This is the
// shared model behind both `thaloca discover` and the desktop app's
// Runtime/Overview views — nothing here is persisted, callers re-scan live.
type Service struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Source      string            `json:"source"`
	Ports       []int             `json:"ports"`
	HealthURL   string            `json:"health_url"`
	Status      string            `json:"status"`
	PID         int               `json:"pid"`
	ContainerID string            `json:"container_id"`
	RepoPath    string            `json:"repo_path"`
	Command     string            `json:"command"`
	Project     string            `json:"project,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Image       string            `json:"image,omitempty"`  // docker only
	Engine      string            `json:"engine,omitempty"` // docker only — which docker context this container came from (e.g. "orbstack", "desktop-linux")
}

// healthProbePaths are well-known health endpoints tried in order when the
// guessed endpoint does not answer 2xx. "/" is last so a plain web app that
// answers its root is still reported as up.
var healthProbePaths = health.ProbePaths

// DockerContextStatus is one Docker context's scan result — lets callers
// tell "this engine's containers are included" apart from "this engine
// exists but couldn't be reached" instead of the two looking identical.
type DockerContextStatus struct {
	Context string
	Error   string
}

// ScanDocker merges containers from every Docker context registered on this
// machine (OrbStack, Docker Desktop, Colima, Rancher Desktop, ... —
// anything `docker context ls` lists), tagging each container with which
// one it came from (Service.Engine), and deduplicating by container ID in
// case two contexts happen to point at the same daemon (common with
// OrbStack, which also takes over the "default" context while it's
// running). Includes stopped containers so they can be started again.
//
// A context that can't be reached (not running, stale, ...) is skipped
// individually rather than failing the whole scan — its error comes back
// in the second return value. The third return value (error) is only
// non-nil when NOT ONE context could be reached (including the `docker`
// CLI itself being missing), matching ScanDocker's old all-or-nothing
// contract for existing callers that only check that.
func ScanDocker(ctx context.Context) ([]Service, []DockerContextStatus, error) {
	if _, err := exec.LookPath("docker"); err != nil {
		return nil, nil, err
	}

	contexts, ctxErr := dockerContextNames(ctx)
	if ctxErr != nil || len(contexts) == 0 {
		// `docker context ls` failed (very old CLI, etc.) — fall back to
		// whichever context is already active, same as before this existed.
		services, err := scanDockerContext(ctx, "")
		if err != nil {
			return nil, nil, err
		}
		return services, nil, nil
	}

	var all []Service
	seenContainers := map[string]bool{}
	var statuses []DockerContextStatus
	var lastErr error
	reached := 0
	for _, name := range contexts {
		services, err := scanDockerContext(ctx, name)
		if err != nil {
			statuses = append(statuses, DockerContextStatus{Context: name, Error: DockerErrorDetail(err)})
			lastErr = err
			continue
		}
		reached++
		for _, svc := range services {
			if seenContainers[svc.ContainerID] {
				continue
			}
			seenContainers[svc.ContainerID] = true
			svc.Engine = name
			all = append(all, svc)
		}
	}
	if reached == 0 {
		return nil, statuses, lastErr
	}
	return all, statuses, nil
}

// DockerErrorDetail extracts a short, human-readable reason from a failed
// `docker` invocation — exec.Cmd.Output() populates *exec.ExitError.Stderr
// with whatever the CLI printed (e.g. "Cannot connect to the Docker daemon
// at unix:///var/run/docker.sock. Is the docker daemon running?"), which is
// far more useful to show than the generic exit-status error alone.
func DockerErrorDetail(err error) string {
	if exitErr, ok := err.(*exec.ExitError); ok && len(exitErr.Stderr) > 0 {
		msg := strings.TrimSpace(string(exitErr.Stderr))
		if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
			msg = msg[:idx]
		}
		return msg
	}
	return err.Error()
}

// dockerContextNames lists every context `docker` knows about (OrbStack,
// Docker Desktop, Colima, Rancher Desktop, ... register themselves this
// way) — not just the currently active one.
func dockerContextNames(ctx context.Context) ([]string, error) {
	out, err := exec.CommandContext(ctx, "docker", "context", "ls", "--format", "{{.Name}}").Output()
	if err != nil {
		return nil, err
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// scanDockerContext runs `docker ps` against one context (or whatever is
// currently active, if contextName is "") and parses the NDJSON output.
func scanDockerContext(ctx context.Context, contextName string) ([]Service, error) {
	var args []string
	if contextName != "" {
		args = append(args, "--context", contextName)
	}
	// -a includes stopped containers so they can be started from the UI.
	args = append(args, "ps", "-a", "--format", "json")
	output, err := exec.CommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, err
	}

	var services []Service
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		var container struct {
			ID      string `json:"ID"`
			Names   string `json:"Names"`
			Image   string `json:"Image"`
			Ports   string `json:"Ports"`
			State   string `json:"State"`
			Health  string `json:"Health"`
			Command string `json:"Command"`
			Labels  string `json:"Labels"`
		}
		if err := json.Unmarshal([]byte(line), &container); err != nil {
			continue
		}

		ports := ParseDockerPorts(container.Ports)
		healthURL := ExtractHealthURL(container.Labels, ports)
		labels := ParseLabels(container.Labels)

		svc := Service{
			ID:          "docker:" + ShortID(container.ID),
			Name:        strings.TrimPrefix(container.Names, "/"),
			Source:      "docker",
			Ports:       ports,
			HealthURL:   healthURL,
			Status:      NormalizeDockerStatus(container.State, container.Health),
			ContainerID: container.ID,
			Command:     container.Command,
			Project:     labels["com.docker.compose.project"],
			Labels:      labels,
			Image:       container.Image,
		}
		services = append(services, svc)
	}

	return services, nil
}

// DockerFullCommand returns a container's entrypoint+cmd as a clean string.
func DockerFullCommand(ctx context.Context, containerID string) string {
	containerID = strings.TrimSpace(containerID)
	if containerID == "" {
		return ""
	}
	output, err := exec.CommandContext(ctx, "docker", "inspect", "--format", "{{json .Config.Entrypoint}} {{json .Config.Cmd}}", containerID).Output()
	if err != nil {
		return ""
	}
	return CleanDockerCommand(string(output))
}

func CleanDockerCommand(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.ReplaceAll(raw, "[", "")
	raw = strings.ReplaceAll(raw, "]", "")
	raw = strings.ReplaceAll(raw, `"`, "")
	raw = strings.ReplaceAll(raw, ",", " ")
	return strings.Join(strings.Fields(raw), " ")
}

// ScanProcesses lists local (non-Docker) processes listening on a TCP port,
// via the same DarwinScanner used for raw Listener discovery.
func ScanProcesses(ctx context.Context) ([]Service, error) {
	if runtime.GOOS != "darwin" {
		return nil, nil
	}

	listeners, err := NewDarwinScanner().Scan(ctx)
	if err != nil {
		return nil, err
	}

	var services []Service
	for _, l := range listeners {
		if IsDockerProcess(l.Process) {
			continue
		}

		healthURL := GuessHealthURL(l.Port)
		svc := Service{
			ID:        fmt.Sprintf("process:%s-%d", l.Process, l.Port),
			Name:      l.Process,
			Source:    "process",
			Ports:     []int{l.Port},
			HealthURL: healthURL,
			Status:    "running",
			PID:       l.PID,
			Command:   l.Process,
		}
		services = append(services, svc)
	}

	return services, nil
}

// ScanGitRepos finds git repositories under the given search roots (each
// walked up to 5 levels deep) and returns them as Service values.
func ScanGitRepos(_ context.Context, roots []string) ([]Service, error) {
	var services []Service
	for _, dir := range roots {
		repos, _ := FindGitRepos(dir, 5)
		for _, repoPath := range repos {
			svc := Service{
				ID:       "git:" + strings.ReplaceAll(repoPath, "/", "-"),
				Name:     filepath.Base(repoPath),
				Source:   "git",
				Ports:    []int{},
				Status:   "active",
				RepoPath: repoPath,
				Command:  "git repository",
				Labels:   map[string]string{},
			}
			services = append(services, svc)
		}
	}

	return services, nil
}

// Deduplicate merges services that share a port, keeping the highest-
// priority source (docker > process > git) for each port; services without
// a port are all kept as-is.
func Deduplicate(services []Service) []Service {
	priority := map[string]int{"docker": 4, "process": 2, "git": 1}

	portMap := make(map[int][]Service)
	byID := make(map[string]Service, len(services))
	orderIndex := make(map[string]int, len(services))
	var order []string
	var noPort []Service
	for _, svc := range services {
		if _, ok := byID[svc.ID]; !ok {
			byID[svc.ID] = svc
			orderIndex[svc.ID] = len(order)
			order = append(order, svc.ID)
		}
		for _, port := range svc.Ports {
			portMap[port] = append(portMap[port], svc)
		}
		if len(svc.Ports) == 0 {
			noPort = append(noPort, svc)
		}
	}

	var result []Service
	seen := make(map[string]bool)
	add := func(svc Service) {
		if !seen[svc.ID] {
			result = append(result, svc)
			seen[svc.ID] = true
		}
	}

	// A service keeps only the ports on which no other service sharing that
	// port has a strictly higher-priority source (ties broken by whichever
	// was seen first). This is checked across ALL of a service's ports
	// before deciding what to include. Losing a port to a strictly
	// higher-priority source (e.g. a raw "process" entry that's really just
	// the docker-proxy for a container already listed under "docker") means
	// this entry is a duplicate view of that same higher-priority service,
	// so if it loses every port that way it's dropped entirely. But losing
	// a port only on the same-priority tie-break (two distinct containers
	// racing for one host port) doesn't mean the loser stopped existing —
	// it just can't claim that port, so it's still kept, minus that port.
	for _, id := range order {
		svc := byID[id]
		if len(svc.Ports) == 0 {
			continue
		}
		var kept []int
		dominated := false
		for _, port := range svc.Ports {
			won := true
			for _, other := range portMap[port] {
				if other.ID == svc.ID {
					continue
				}
				if priority[other.Source] > priority[svc.Source] {
					won = false
					dominated = true
					break
				}
				if priority[other.Source] == priority[svc.Source] && orderIndex[other.ID] < orderIndex[svc.ID] {
					won = false
					break
				}
			}
			if won {
				kept = append(kept, port)
			}
		}
		if len(kept) == 0 && dominated {
			continue
		}
		svc.Ports = kept
		add(svc)
	}

	// Services without ports (git repos, background containers) are all kept.
	for _, svc := range noPort {
		add(svc)
	}

	sort.Slice(result, func(i, j int) bool {
		if priority[result[i].Source] != priority[result[j].Source] {
			return priority[result[i].Source] > priority[result[j].Source]
		}
		return result[i].Name < result[j].Name
	})

	return result
}

func ParseDockerPorts(portsStr string) []int {
	var ports []int
	parts := strings.Split(portsStr, ",")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		// Host address can be IPv4 ("0.0.0.0:8080->80/tcp") or IPv6
		// ("[::]:8080->80/tcp" or Docker's shorthand ":::8080->80/tcp"),
		// so find the port by working backwards from "->" rather than
		// from the first ':' — an IPv6 address contains colons of its own.
		idx2 := strings.Index(p, "->")
		if idx2 < 0 {
			continue
		}
		hostPart := p[:idx2]
		idx := strings.LastIndex(hostPart, ":")
		if idx < 0 {
			continue
		}
		hostPort := hostPart[idx+1:]
		var port int
		fmt.Sscanf(hostPort, "%d", &port)
		if port > 0 {
			ports = append(ports, port)
		}
	}
	return ports
}

func ExtractHealthURL(labelsStr string, ports []int) string {
	labels := ParseLabels(labelsStr)
	if url, ok := labels["com.thaloca.health"]; ok {
		return url
	}
	if len(ports) > 0 {
		return fmt.Sprintf("http://localhost:%d%s", ports[0], healthProbePaths[0])
	}
	return ""
}

func ParseLabels(labelsStr string) map[string]string {
	result := make(map[string]string)
	if labelsStr == "" {
		return result
	}
	pairs := strings.Split(labelsStr, ",")
	for _, pair := range pairs {
		kv := strings.SplitN(pair, "=", 2)
		if len(kv) == 2 {
			result[kv[0]] = kv[1]
		}
	}
	return result
}

func NormalizeDockerStatus(state, containerHealth string) string {
	switch strings.ToLower(state) {
	case "running":
		if containerHealth == "healthy" {
			return "healthy"
		}
		if containerHealth == "unhealthy" {
			return "unhealthy"
		}
		return "running"
	case "exited", "dead", "created":
		return "stopped"
	default:
		return "unknown"
	}
}

func GuessHealthURL(port int) string {
	return fmt.Sprintf("http://localhost:%d%s", port, healthProbePaths[0])
}

func IsDockerProcess(process string) bool {
	dockerProcs := []string{"docker-proxy", "containerd", "dockerd", "vpnkit", "com.docker"}
	for _, dp := range dockerProcs {
		if strings.Contains(strings.ToLower(process), dp) {
			return true
		}
	}
	return false
}

func DockerComposeProject(labels string) string {
	values := ParseLabels(labels)
	if project := values["com.docker.compose.project"]; project != "" {
		return project
	}
	return ""
}

func ShortID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 12 {
		return value
	}
	return value[:12]
}

// GitSearchRoots returns the common developer folders (plus every mounted
// volume on macOS) to look for git repositories in.
func GitSearchRoots() []string {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	candidates := []string{
		filepath.Join(homeDir, "Projects"),
		filepath.Join(homeDir, "Code"),
		filepath.Join(homeDir, "work"),
		filepath.Join(homeDir, "dev"),
		filepath.Join(homeDir, "github"),
		filepath.Join(homeDir, "gitlab"),
		filepath.Join(homeDir, "Documents"),
		filepath.Join(homeDir, ".openclaw"),
	}
	if volumes, err := os.ReadDir("/Volumes"); err == nil {
		for _, volume := range volumes {
			if volume.IsDir() {
				candidates = append(candidates, filepath.Join("/Volumes", volume.Name()))
			}
		}
	}
	var roots []string
	seen := map[string]bool{}
	for _, root := range candidates {
		if root == "" || seen[root] {
			continue
		}
		if info, err := os.Stat(root); err == nil && info.IsDir() {
			roots = append(roots, root)
			seen[root] = true
		}
	}
	return roots
}

// FindGitRepos walks root up to maxDepth levels looking for ".git" directories.
func FindGitRepos(root string, maxDepth int) ([]string, error) {
	var repos []string
	root = filepath.Clean(root)
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if path != root && shouldSkipGitSearchDir(name) {
			return filepath.SkipDir
		}
		if depth := pathDepth(root, path); maxDepth > 0 && depth > maxDepth {
			return filepath.SkipDir
		}
		if d.IsDir() && d.Name() == ".git" {
			repos = append(repos, filepath.Dir(path))
			return filepath.SkipDir
		}
		return nil
	})
	return repos, err
}

func shouldSkipGitSearchDir(name string) bool {
	switch name {
	case "node_modules", "vendor", ".cache", "Library", "Applications", "System", ".Trash", "tmp", "dist", "build", ".next":
		return true
	default:
		return false
	}
}

func pathDepth(root, path string) int {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." {
		return 0
	}
	return len(strings.Split(rel, string(os.PathSeparator)))
}
