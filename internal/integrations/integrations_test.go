package integrations

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestScanLaravel(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "artisan"), []byte("#!/usr/bin/env php"), 0o600); err != nil {
		t.Fatal(err)
	}
	snapshot := Scan(context.Background(), root)
	if !snapshot.Laravel.Detected || len(snapshot.Laravel.Jobs) != 3 {
		t.Fatalf("Scan() = %+v", snapshot.Laravel)
	}
}

func TestScanReturnsEmptySlices(t *testing.T) {
	snapshot := Scan(context.Background(), t.TempDir())
	if snapshot.Docker.Containers == nil || snapshot.PM2.Processes == nil || snapshot.Laravel.Jobs == nil {
		t.Fatalf("Scan() contains nil slices: %+v", snapshot)
	}
}
