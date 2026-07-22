package discovery

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
)

// DockerVolume is one entry from `docker volume ls`.
type DockerVolume struct {
	Name       string `json:"name"`
	Driver     string `json:"driver"`
	Mountpoint string `json:"mountpoint"`
	Scope      string `json:"scope"`
	InUse      bool   `json:"in_use"`
	Engine     string `json:"engine,omitempty"` // which docker context this volume came from, e.g. "orbstack"
}

// DockerNetwork is one entry from `docker network ls`.
type DockerNetwork struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Driver string `json:"driver"`
	Scope  string `json:"scope"`
	InUse  bool   `json:"in_use"`
	Engine string `json:"engine,omitempty"`
}

// DockerImage is one entry from `docker image ls`.
type DockerImage struct {
	ID         string `json:"id"`
	Repository string `json:"repository"`
	Tag        string `json:"tag"`
	Size       string `json:"size"`
	Created    string `json:"created"`
	InUse      bool   `json:"in_use"`
	Engine     string `json:"engine,omitempty"`
}

// dockerArgs prepends --context contextName (skipped when empty, meaning
// "whatever context is currently active") to extra — the same per-call
// targeting scanDockerContext (service.go) uses for containers.
func dockerArgs(contextName string, extra ...string) []string {
	args := make([]string, 0, len(extra)+2)
	if contextName != "" {
		args = append(args, "--context", contextName)
	}
	return append(args, extra...)
}

// uniqueDockerContexts returns one context name per distinct Docker daemon
// registered on this machine, resolved via `docker info`'s daemon ID.
// OrbStack, for instance, commonly answers under both its own "orbstack"
// context AND whichever context is "default" while it's running — scanning
// both would double-list every volume/network/image it has. This is the
// reason volumes/networks/images must NOT be deduplicated by name/ID alone
// afterward (unlike containers, whose IDs are unique per instance and so
// never legitimately collide): two genuinely different daemons (e.g.
// Colima and OrbStack both installed) can easily share a volume name or an
// image ID (content-addressed, so identical pulled images always do), and
// naively deduping those would silently hide one daemon's copy.
func uniqueDockerContexts(ctx context.Context) ([]string, error) {
	names, err := dockerContextNames(ctx)
	if err != nil {
		return nil, err
	}
	var unique []string
	seenDaemons := map[string]bool{}
	for _, name := range names {
		id := dockerDaemonID(ctx, name)
		// A context whose daemon ID couldn't be determined (unreachable,
		// or an old Docker CLI) is kept on its own rather than dropped —
		// scanVolumesContext/scanNetworksContext/scanImagesContext already
		// tolerate an individually-unreachable context.
		if id != "" && seenDaemons[id] {
			continue
		}
		if id != "" {
			seenDaemons[id] = true
		}
		unique = append(unique, name)
	}
	return unique, nil
}

func dockerDaemonID(ctx context.Context, contextName string) string {
	output, err := exec.CommandContext(ctx, "docker", dockerArgs(contextName, "info", "--format", "{{.ID}}")...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

// ScanVolumes lists Docker volumes across every distinct Docker daemon
// registered on this machine (OrbStack, Docker Desktop, Colima, ...) — a
// volume that only exists under a context other than the currently active
// one would otherwise go missing entirely. InUse is derived from Docker's
// own "dangling" filter — a volume is dangling when no container (running
// or stopped) references it.
func ScanVolumes(ctx context.Context) ([]DockerVolume, error) {
	contexts, ctxErr := uniqueDockerContexts(ctx)
	if ctxErr != nil || len(contexts) == 0 {
		return scanVolumesContext(ctx, "")
	}

	var all []DockerVolume
	var lastErr error
	reached := 0
	for _, name := range contexts {
		volumes, err := scanVolumesContext(ctx, name)
		if err != nil {
			lastErr = err
			continue
		}
		reached++
		all = append(all, volumes...)
	}
	if reached == 0 {
		return nil, lastErr
	}
	return all, nil
}

func scanVolumesContext(ctx context.Context, contextName string) ([]DockerVolume, error) {
	output, err := exec.CommandContext(ctx, "docker", dockerArgs(contextName, "volume", "ls", "--format", "{{json .}}")...).Output()
	if err != nil {
		return nil, err
	}
	// Best-effort: if this second call fails, dangling stays empty and
	// every volume below is reported as in-use rather than wrongly flagged
	// as unused.
	danglingOutput, _ := exec.CommandContext(ctx, "docker", dockerArgs(contextName, "volume", "ls", "-f", "dangling=true", "--format", "{{.Name}}")...).Output()
	dangling := map[string]bool{}
	for _, name := range strings.Split(strings.TrimSpace(string(danglingOutput)), "\n") {
		if name = strings.TrimSpace(name); name != "" {
			dangling[name] = true
		}
	}

	var volumes []DockerVolume
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		var v struct {
			Name       string `json:"Name"`
			Driver     string `json:"Driver"`
			Mountpoint string `json:"Mountpoint"`
			Scope      string `json:"Scope"`
		}
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			continue
		}
		volumes = append(volumes, DockerVolume{Name: v.Name, Driver: v.Driver, Mountpoint: v.Mountpoint, Scope: v.Scope, InUse: !dangling[v.Name], Engine: contextName})
	}
	return volumes, nil
}

// ScanNetworks lists Docker networks across every distinct Docker daemon,
// same reasoning as ScanVolumes. InUse reflects whether any container is
// currently attached to it, via a single batched `docker network inspect`
// covering every network in that context at once.
func ScanNetworks(ctx context.Context) ([]DockerNetwork, error) {
	contexts, ctxErr := uniqueDockerContexts(ctx)
	if ctxErr != nil || len(contexts) == 0 {
		return scanNetworksContext(ctx, "")
	}

	var all []DockerNetwork
	var lastErr error
	reached := 0
	for _, name := range contexts {
		networks, err := scanNetworksContext(ctx, name)
		if err != nil {
			lastErr = err
			continue
		}
		reached++
		all = append(all, networks...)
	}
	if reached == 0 {
		return nil, lastErr
	}
	return all, nil
}

func scanNetworksContext(ctx context.Context, contextName string) ([]DockerNetwork, error) {
	output, err := exec.CommandContext(ctx, "docker", dockerArgs(contextName, "network", "ls", "--format", "{{json .}}")...).Output()
	if err != nil {
		return nil, err
	}
	var networks []DockerNetwork
	var ids []string
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		var n struct {
			ID     string `json:"ID"`
			Name   string `json:"Name"`
			Driver string `json:"Driver"`
			Scope  string `json:"Scope"`
		}
		if err := json.Unmarshal([]byte(line), &n); err != nil {
			continue
		}
		networks = append(networks, DockerNetwork{ID: n.ID, Name: n.Name, Driver: n.Driver, Scope: n.Scope, Engine: contextName})
		ids = append(ids, n.ID)
	}

	if len(ids) > 0 {
		inspectOutput, err := exec.CommandContext(ctx, "docker", dockerArgs(contextName, append([]string{"network", "inspect", "--format", "{{len .Containers}}"}, ids...)...)...).Output()
		if err != nil {
			// This is a destructive action's hint — if we can't tell
			// whether a network is attached to anything, default every
			// one of them to "in use" rather than wrongly suggesting
			// they're all safe to remove.
			for i := range networks {
				networks[i].InUse = true
			}
		} else {
			counts := strings.Split(strings.TrimSpace(string(inspectOutput)), "\n")
			for i := range networks {
				if i >= len(counts) || strings.TrimSpace(counts[i]) != "0" {
					networks[i].InUse = true
				}
			}
		}
	}
	return networks, nil
}

// ScanImages lists Docker images (including dangling/untagged ones, via -a)
// across every distinct Docker daemon, same reasoning as ScanVolumes. InUse
// is derived by cross-referencing each image's repo:tag and ID against the
// "Image" reference every container (running or stopped) was created
// with — the same reference `docker ps` reports, rather than the
// version-inconsistent `.Containers` image-ls template field.
func ScanImages(ctx context.Context) ([]DockerImage, error) {
	contexts, ctxErr := uniqueDockerContexts(ctx)
	if ctxErr != nil || len(contexts) == 0 {
		return scanImagesContext(ctx, "")
	}

	var all []DockerImage
	var lastErr error
	reached := 0
	for _, name := range contexts {
		images, err := scanImagesContext(ctx, name)
		if err != nil {
			lastErr = err
			continue
		}
		reached++
		all = append(all, images...)
	}
	if reached == 0 {
		return nil, lastErr
	}
	return all, nil
}

func scanImagesContext(ctx context.Context, contextName string) ([]DockerImage, error) {
	output, err := exec.CommandContext(ctx, "docker", dockerArgs(contextName, "image", "ls", "-a", "--format", "{{json .}}")...).Output()
	if err != nil {
		return nil, err
	}
	// This is a destructive action's hint — if the "what's in use" probe
	// fails, every image below defaults to "in use" rather than wrongly
	// suggesting they're all safe to remove.
	usedOutput, psErr := exec.CommandContext(ctx, "docker", dockerArgs(contextName, "ps", "-a", "--format", "{{.Image}}")...).Output()
	used := map[string]bool{}
	for _, ref := range strings.Split(strings.TrimSpace(string(usedOutput)), "\n") {
		if ref = strings.TrimSpace(ref); ref != "" {
			used[ref] = true
		}
	}

	var images []DockerImage
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		var img struct {
			ID         string `json:"ID"`
			Repository string `json:"Repository"`
			Tag        string `json:"Tag"`
			Size       string `json:"Size"`
			CreatedAt  string `json:"CreatedAt"`
		}
		if err := json.Unmarshal([]byte(line), &img); err != nil {
			continue
		}
		repoTag := img.Repository
		if img.Tag != "" && img.Tag != "<none>" {
			repoTag = img.Repository + ":" + img.Tag
		}
		inUse := psErr != nil || used[repoTag] || used[img.ID] || used["sha256:"+img.ID]
		images = append(images, DockerImage{ID: img.ID, Repository: img.Repository, Tag: img.Tag, Size: img.Size, Created: img.CreatedAt, InUse: inUse, Engine: contextName})
	}
	return images, nil
}
