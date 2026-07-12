package detection

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Result struct {
	Root       string   `json:"root,omitempty"`
	Name       string   `json:"name,omitempty"`
	Framework  string   `json:"framework,omitempty"`
	Confidence int      `json:"confidence"`
	Evidence   []string `json:"evidence,omitempty"`
}

// Detect walks upward from path and identifies the nearest supported project.
func Detect(path string) Result {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Result{}
	}
	if info, statErr := os.Stat(absolute); statErr == nil && !info.IsDir() {
		absolute = filepath.Dir(absolute)
	}

	for current := absolute; ; current = filepath.Dir(current) {
		if result, ok := detectRoot(current); ok {
			return result
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
	}
	return Result{}
}

func detectRoot(root string) (Result, bool) {
	result := Result{Root: root, Name: filepath.Base(root)}
	if exists(root, "artisan") {
		result.Framework, result.Confidence = "Laravel", 70
		result.Evidence = append(result.Evidence, "artisan found")
		if fileContains(filepath.Join(root, "composer.json"), "laravel/framework") {
			result.Confidence = 95
			result.Evidence = append(result.Evidence, "composer.json contains laravel/framework")
		}
		return result, true
	}
	if exists(root, "manage.py") {
		result.Framework, result.Confidence = "Django", 80
		result.Evidence = append(result.Evidence, "manage.py found")
		return result, true
	}
	if exists(root, "go.mod") {
		result.Framework, result.Confidence = "Go", 90
		result.Evidence = append(result.Evidence, "go.mod found")
		return result, true
	}
	if exists(root, "package.json") {
		framework := "Node.js"
		confidence := 70
		evidence := "package.json found"
		content, _ := os.ReadFile(filepath.Join(root, "package.json"))
		var manifest map[string]any
		_ = json.Unmarshal(content, &manifest)
		raw := string(content)
		switch {
		case strings.Contains(raw, "\"nuxt\""):
			framework, confidence, evidence = "Nuxt", 90, "package.json contains nuxt"
		case strings.Contains(raw, "\"next\""):
			framework, confidence, evidence = "Next.js", 90, "package.json contains next"
		case strings.Contains(raw, "\"vite\""):
			framework, confidence, evidence = "Vite", 85, "package.json contains vite"
		}
		result.Framework, result.Confidence = framework, confidence
		result.Evidence = append(result.Evidence, evidence)
		return result, true
	}
	if exists(root, "docker-compose.yml") || exists(root, "compose.yml") || exists(root, "compose.yaml") {
		result.Framework, result.Confidence = "Docker Compose", 85
		result.Evidence = append(result.Evidence, "compose manifest found")
		return result, true
	}
	return Result{}, false
}

func exists(root, name string) bool {
	_, err := os.Stat(filepath.Join(root, name))
	return err == nil
}

func fileContains(path, needle string) bool {
	content, err := os.ReadFile(path)
	return err == nil && strings.Contains(string(content), needle)
}
