package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestListEnvFilesKeysOnly(t *testing.T) {
	dir := t.TempDir()
	content := "# comment\nAPI_KEY=super-secret\nPORT=3000\n\nEMPTY_LINE_ABOVE=1\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	a := &App{repoCache: []string{dir}, repoCacheAt: time.Now()}
	summaries := a.ListEnvFiles()
	if len(summaries) != 1 {
		t.Fatalf("expected 1 env file, got %d: %v", len(summaries), summaries)
	}
	got := summaries[0]
	if got.FileName != ".env" || got.ProjectPath != dir {
		t.Fatalf("unexpected summary: %+v", got)
	}
	want := []string{"API_KEY", "PORT", "EMPTY_LINE_ABOVE"}
	if len(got.Keys) != len(want) {
		t.Fatalf("expected keys %v, got %v", want, got.Keys)
	}
	for i, k := range want {
		if got.Keys[i] != k {
			t.Errorf("key[%d] = %q, want %q", i, got.Keys[i], k)
		}
	}
}

func TestGetEnvValueOnlyKnownProjectAndFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=abc123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &App{repoCache: []string{dir}, repoCacheAt: time.Now()}

	value, err := a.GetEnvValue(dir, ".env", "SECRET")
	if err != nil || value != "abc123" {
		t.Fatalf("GetEnvValue() = %q, %v; want abc123, nil", value, err)
	}

	if _, err := a.GetEnvValue("/some/unknown/path", ".env", "SECRET"); err == nil {
		t.Error("expected error for a project path Thaloca never discovered")
	}
	if _, err := a.GetEnvValue(dir, "../../etc/passwd", "SECRET"); err == nil {
		t.Error("expected error for a file name outside the known .env variants")
	}
	if _, err := a.GetEnvValue(dir, ".env", "NOT_A_KEY"); err == nil {
		t.Error("expected error for a key that doesn't exist in the file")
	}
}

func TestGetEnvFileContentOnlyKnownProjectAndFile(t *testing.T) {
	dir := t.TempDir()
	content := "# comment\nSECRET=abc123\nPORT=3000\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &App{repoCache: []string{dir}, repoCacheAt: time.Now()}

	got, err := a.GetEnvFileContent(dir, ".env")
	if err != nil || got != content {
		t.Fatalf("GetEnvFileContent() = %q, %v; want %q, nil", got, err, content)
	}

	if _, err := a.GetEnvFileContent("/some/unknown/path", ".env"); err == nil {
		t.Error("expected error for a project path Thaloca never discovered")
	}
	if _, err := a.GetEnvFileContent(dir, "../../etc/passwd"); err == nil {
		t.Error("expected error for a file name outside the known .env variants")
	}
}
