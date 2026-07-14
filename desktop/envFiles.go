package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// EnvFileSummary lists which keys a project's .env file defines — never
// the values. Values are only ever read one at a time, on explicit
// request (see GetEnvValue), and never cached or logged here: aggregating
// every discovered project's real secrets into one place would turn any
// future bug in Thaloca itself into a leak of ALL of them at once, instead
// of a bug affecting one project's own .env.
type EnvFileSummary struct {
	ProjectPath string   `json:"project_path"`
	ProjectName string   `json:"project_name"`
	FileName    string   `json:"file_name"`
	Keys        []string `json:"keys"`
}

// envFileNames are the .env variants looked for — deliberately not a
// recursive/glob search, so this only ever sees a file sitting right at a
// discovered project's root, never a stray .env nested inside e.g.
// node_modules.
var envFileNames = []string{".env", ".env.local", ".env.development", ".env.production", ".env.staging", ".env.test"}

func envKeysInFile(path string) []string {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	var keys []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		if key := strings.TrimSpace(line[:eq]); key != "" {
			keys = append(keys, key)
		}
	}
	return keys
}

// ListEnvFiles scans every discovered project for .env files at its root
// and returns which keys each one defines. Values are never read here.
func (a *App) ListEnvFiles() []EnvFileSummary {
	var summaries []EnvFileSummary
	for _, repoPath := range a.cachedRepoPaths(false) {
		for _, name := range envFileNames {
			full := filepath.Join(repoPath, name)
			info, err := os.Stat(full)
			if err != nil || info.IsDir() {
				continue
			}
			keys := envKeysInFile(full)
			if len(keys) == 0 {
				continue
			}
			summaries = append(summaries, EnvFileSummary{
				ProjectPath: repoPath,
				ProjectName: filepath.Base(repoPath),
				FileName:    name,
				Keys:        keys,
			})
		}
	}
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].ProjectName != summaries[j].ProjectName {
			return summaries[i].ProjectName < summaries[j].ProjectName
		}
		return summaries[i].FileName < summaries[j].FileName
	})
	return summaries
}

// validateEnvFileAccess re-checks projectPath/fileName against what
// Thaloca itself already discovered rather than trusting them as arbitrary
// input from the frontend, so GetEnvValue/GetEnvFileContent can't be used
// to read an unrelated file.
func (a *App) validateEnvFileAccess(projectPath, fileName string) error {
	known := false
	for _, p := range a.cachedRepoPaths(false) {
		if p == projectPath {
			known = true
			break
		}
	}
	if !known {
		return fmt.Errorf("unknown project")
	}
	validName := false
	for _, name := range envFileNames {
		if name == fileName {
			validName = true
			break
		}
	}
	if !validName {
		return fmt.Errorf("unsupported .env file name")
	}
	return nil
}

// GetEnvValue reads exactly one key's value from exactly one project's
// .env file, only on explicit request.
func (a *App) GetEnvValue(projectPath, fileName, key string) (string, error) {
	if err := a.validateEnvFileAccess(projectPath, fileName); err != nil {
		return "", err
	}

	file, err := os.Open(filepath.Join(projectPath, fileName))
	if err != nil {
		return "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		if strings.TrimSpace(line[:eq]) != key {
			continue
		}
		value := strings.TrimSpace(line[eq+1:])
		value = strings.Trim(value, `"'`)
		return value, nil
	}
	return "", fmt.Errorf("key not found")
}

// GetEnvFileContent returns one .env file's raw content verbatim (every
// real value, comments, and blank lines included) — unlike ListEnvFiles
// (key names only) and GetEnvValue (one value at a time), this is the one
// path that hands back a whole file's actual secrets at once, so it's only
// ever called from the explicit "Copy file" button, never on tab load.
func (a *App) GetEnvFileContent(projectPath, fileName string) (string, error) {
	if err := a.validateEnvFileAccess(projectPath, fileName); err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(projectPath, fileName))
	if err != nil {
		return "", err
	}
	return string(data), nil
}
