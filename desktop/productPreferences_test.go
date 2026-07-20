package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductPreferencesPersistExpectedStateAndWorkspace(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	app := &App{}
	prefs, err := app.SetProjectExpectedState("demo", "on_demand")
	if err != nil || prefs.ExpectedProjects["demo"] != "on_demand" {
		t.Fatalf("expected state was not saved: %#v %v", prefs, err)
	}
	prefs, err = app.SaveWorkspaceProfile(WorkspaceProfile{Name: "Work", Projects: []string{"demo", "demo", "api"}})
	if err != nil || len(prefs.Workspaces) != 1 || len(prefs.Workspaces[0].Projects) != 2 {
		t.Fatalf("workspace was not normalized: %#v %v", prefs, err)
	}
}

func TestProductPreferencesRejectInvalidExpectedState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := (&App{}).SetProjectExpectedState("demo", "sometimes"); err == nil {
		t.Fatal("invalid expected state must fail")
	}
}

func TestDocumentPolicyRejectsUnimplementedFulltextMode(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := (&App{}).SetDocumentRootPolicy("/tmp/docs", DocumentRootPolicy{Mode: "fulltext"}); err == nil || !strings.Contains(err.Error(), "invalid indexing mode") {
		t.Fatalf("fulltext must not be accepted without a distinct indexing pipeline: %v", err)
	}
}

func TestLegacyFulltextPolicyLoadsAsSemantic(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".thaloca")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "product-preferences.json"), []byte(`{"document_policies":{"/docs":{"mode":"fulltext"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadProductPreferences().DocumentPolicies["/docs"].Mode; got != "semantic" {
		t.Fatalf("legacy fulltext policy = %q, want semantic", got)
	}
}
