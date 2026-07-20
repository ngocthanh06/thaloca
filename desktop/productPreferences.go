package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type WorkspaceProfile struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Projects []string `json:"projects"`
}

type DocumentRootPolicy struct {
	Mode      string `json:"mode"` // semantic | excluded
	MaxMB     int    `json:"max_mb"`
	MaxPages  int    `json:"max_pages"`
	MaxSlides int    `json:"max_slides"`
}

type ProductPreferences struct {
	ExpectedProjects map[string]string             `json:"expected_projects"` // required | on_demand | muted
	Workspaces       []WorkspaceProfile            `json:"workspaces"`
	DocumentPolicies map[string]DocumentRootPolicy `json:"document_policies"`
}

func defaultProductPreferences() ProductPreferences {
	return ProductPreferences{ExpectedProjects: map[string]string{}, Workspaces: []WorkspaceProfile{}, DocumentPolicies: map[string]DocumentRootPolicy{}}
}

func productPreferencesPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".thaloca", "product-preferences.json"), nil
}

func loadProductPreferences() ProductPreferences {
	prefs := defaultProductPreferences()
	path, err := productPreferencesPath()
	if err != nil {
		return prefs
	}
	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &prefs) != nil {
		return defaultProductPreferences()
	}
	if prefs.ExpectedProjects == nil {
		prefs.ExpectedProjects = map[string]string{}
	}
	if prefs.Workspaces == nil {
		prefs.Workspaces = []WorkspaceProfile{}
	}
	if prefs.DocumentPolicies == nil {
		prefs.DocumentPolicies = map[string]DocumentRootPolicy{}
	}
	// Older development builds accepted "fulltext" even though indexing never
	// implemented a distinct full-text-only pipeline. Preserve the effective
	// historical behaviour while removing that misleading internal state.
	for root, policy := range prefs.DocumentPolicies {
		if policy.Mode == "fulltext" {
			policy.Mode = "semantic"
			prefs.DocumentPolicies[root] = policy
		}
	}
	return prefs
}

func saveProductPreferences(prefs ProductPreferences) error {
	path, err := productPreferencesPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *App) ProductPreferences() ProductPreferences { return loadProductPreferences() }

func (a *App) SetProjectExpectedState(project, state string) (ProductPreferences, error) {
	project, state = strings.TrimSpace(project), strings.TrimSpace(state)
	if project == "" {
		return loadProductPreferences(), fmt.Errorf("project is required")
	}
	if state != "required" && state != "on_demand" && state != "muted" {
		return loadProductPreferences(), fmt.Errorf("invalid expected state")
	}
	prefs := loadProductPreferences()
	prefs.ExpectedProjects[project] = state
	return prefs, saveProductPreferences(prefs)
}

func (a *App) SaveWorkspaceProfile(profile WorkspaceProfile) (ProductPreferences, error) {
	profile.ID, profile.Name = strings.TrimSpace(profile.ID), strings.TrimSpace(profile.Name)
	if profile.Name == "" {
		return loadProductPreferences(), fmt.Errorf("workspace name is required")
	}
	if profile.ID == "" {
		profile.ID = documentID(profile.Name)
	}
	clean := make([]string, 0, len(profile.Projects))
	seen := map[string]bool{}
	for _, project := range profile.Projects {
		project = strings.TrimSpace(project)
		if project != "" && !seen[project] {
			seen[project] = true
			clean = append(clean, project)
		}
	}
	sort.Strings(clean)
	profile.Projects = clean
	prefs := loadProductPreferences()
	replaced := false
	for i := range prefs.Workspaces {
		if prefs.Workspaces[i].ID == profile.ID {
			prefs.Workspaces[i] = profile
			replaced = true
			break
		}
	}
	if !replaced {
		prefs.Workspaces = append(prefs.Workspaces, profile)
	}
	return prefs, saveProductPreferences(prefs)
}

func (a *App) DeleteWorkspaceProfile(id string) (ProductPreferences, error) {
	prefs := loadProductPreferences()
	kept := prefs.Workspaces[:0]
	for _, profile := range prefs.Workspaces {
		if profile.ID != id {
			kept = append(kept, profile)
		}
	}
	prefs.Workspaces = kept
	return prefs, saveProductPreferences(prefs)
}

func (a *App) SetDocumentRootPolicy(root string, policy DocumentRootPolicy) (ProductPreferences, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if !filepath.IsAbs(root) {
		return loadProductPreferences(), fmt.Errorf("document root must be absolute")
	}
	if policy.Mode != "semantic" && policy.Mode != "excluded" {
		return loadProductPreferences(), fmt.Errorf("invalid indexing mode")
	}
	if policy.MaxMB <= 0 {
		policy.MaxMB = 20
	}
	if policy.MaxPages <= 0 {
		policy.MaxPages = 200
	}
	if policy.MaxSlides <= 0 {
		policy.MaxSlides = 150
	}
	prefs := loadProductPreferences()
	prefs.DocumentPolicies[root] = policy
	return prefs, saveProductPreferences(prefs)
}
