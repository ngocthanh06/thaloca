package detection

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDetectGoProjectFromNestedDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.com/app\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "internal", "api")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	got := Detect(nested)
	if got.Root != root || got.Framework != "Go" || got.Confidence != 90 {
		t.Fatalf("Detect() = %+v", got)
	}
}

func TestDetectNuxt(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"dependencies":{"nuxt":"latest"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := Detect(root)
	if got.Framework != "Nuxt" || got.Confidence != 90 {
		t.Fatalf("Detect() = %+v", got)
	}
}
