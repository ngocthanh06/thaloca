package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testSHA256 = "784221ae5f3f38b939d71bfa50447a1861a09d95d9260619544fc3c631de1708"

func TestParseSelfUpdateReleaseUsesGitHubDigest(t *testing.T) {
	payload := `{
  "tag_name":"v0.1.7",
  "assets":[
    {"name":"Thaloca.app.zip","browser_download_url":"https://example.test/app.zip","digest":"sha256:` + testSHA256 + `"},
    {"name":"Thaloca.app.zip.sha256","browser_download_url":"https://example.test/app.zip.sha256"}
  ]
}`
	release, err := parseSelfUpdateRelease(strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if release.Version != "0.1.7" || release.DownloadURL != "https://example.test/app.zip" || release.SHA256 != testSHA256 {
		t.Fatalf("unexpected release: %+v", release)
	}
}

func TestParseSelfUpdateReleaseFallsBackToChecksumAsset(t *testing.T) {
	payload := `{"tag_name":"v0.1.7","assets":[
  {"name":"Thaloca.app.zip","browser_download_url":"https://example.test/app.zip"},
  {"name":"Thaloca.app.zip.sha256","browser_download_url":"https://example.test/app.zip.sha256"}
]}`
	release, err := parseSelfUpdateRelease(strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if release.SHA256 != "" || release.ChecksumURL == "" {
		t.Fatalf("expected checksum fallback, got %+v", release)
	}
}

func TestParseSelfUpdateReleaseRequiresVerificationMaterial(t *testing.T) {
	payload := `{"tag_name":"v0.1.7","assets":[{"name":"Thaloca.app.zip","browser_download_url":"https://example.test/app.zip"}]}`
	if _, err := parseSelfUpdateRelease(strings.NewReader(payload)); err == nil {
		t.Fatal("expected release without digest/checksum to be rejected")
	}
}

func TestChecksumFromFile(t *testing.T) {
	got, err := checksumFromFile([]byte(testSHA256 + "  Thaloca.app.zip\n"))
	if err != nil || got != testSHA256 {
		t.Fatalf("checksumFromFile() = %q, %v", got, err)
	}
	if _, err := checksumFromFile([]byte(testSHA256 + "  Wrong.app.zip\n")); err == nil {
		t.Fatal("expected checksum for another asset to be rejected")
	}
}

func TestFindAppBundleRequiresExactlyOneRealBundle(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Thaloca.app")
	if err := os.Mkdir(app, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := findAppBundle(dir); err != nil || got != app {
		t.Fatalf("findAppBundle() = %q, %v", got, err)
	}
	if err := os.Mkdir(filepath.Join(dir, "Other.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := findAppBundle(dir); err == nil {
		t.Fatal("expected archive with multiple app bundles to be rejected")
	}
}
