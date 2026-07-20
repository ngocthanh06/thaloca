package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveCaptureLocation(t *testing.T) {
	home := "/Users/test"
	cases := []struct {
		raw  string
		want string
	}{
		{"", "/Users/test/Desktop"},
		{"   \n", "/Users/test/Desktop"},
		{"relative/path", "/Users/test/Desktop"},
		{"~", "/Users/test"},
		{"~/Pictures/Shots\n", "/Users/test/Pictures/Shots"},
		{"/Users/test/Pictures/Shots/", "/Users/test/Pictures/Shots"},
		{"/Volumes/External/Caps", "/Volumes/External/Caps"},
	}
	for _, tc := range cases {
		if got := resolveCaptureLocation(tc.raw, home); got != tc.want {
			t.Errorf("resolveCaptureLocation(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestCaptureKindClassification(t *testing.T) {
	cases := []struct {
		ext  string
		want string
	}{
		{".png", "image"},
		{".PNG", "image"},
		{".jpeg", "image"},
		{".heic", "image"},
		{".gif", "image"},
		{".mov", "video"},
		{".MOV", "video"},
		{".mp4", "video"},
		{".txt", ""},
		{".pdf", ""},
		{"", ""},
	}
	for _, tc := range cases {
		if got := captureKind(tc.ext); got != tc.want {
			t.Errorf("captureKind(%q) = %q, want %q", tc.ext, got, tc.want)
		}
	}
}

func TestCaptureEditorOnlyOverwritesPNGAndJPEG(t *testing.T) {
	for _, path := range []string{"shot.png", "shot.JPG", "shot.jpeg"} {
		if !captureEditableInApp(path) {
			t.Errorf("%s should be editable in app", path)
		}
	}
	for _, path := range []string{"shot.heic", "animated.gif", "recording.mov"} {
		if captureEditableInApp(path) {
			t.Errorf("%s must not be overwritten by the canvas editor", path)
		}
	}
}

func TestScanCaptureFolder(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, mtime time.Time) {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Now().Add(-time.Hour)
	write("old.png", base)
	write("newer.MOV", base.Add(time.Minute))
	write("newest.jpg", base.Add(2*time.Minute))
	write("notes.txt", base)
	write(".Screenshot in progress.png", base)
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	files, err := scanCaptureFolder(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Fatalf("expected 3 captures, got %d: %+v", len(files), files)
	}
	wantOrder := []string{"newest.jpg", "newer.MOV", "old.png"}
	wantKinds := []string{"image", "video", "image"}
	for i, file := range files {
		if file.Name != wantOrder[i] {
			t.Errorf("position %d: got %q, want %q", i, file.Name, wantOrder[i])
		}
		if file.Kind != wantKinds[i] {
			t.Errorf("%s: kind %q, want %q", file.Name, file.Kind, wantKinds[i])
		}
		if file.Path != filepath.Join(dir, file.Name) {
			t.Errorf("%s: unexpected path %q", file.Name, file.Path)
		}
	}
}

func TestScanCaptureFolderMissingDir(t *testing.T) {
	if _, err := scanCaptureFolder(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("expected an error for a missing directory")
	}
}

func TestValidateCaptureRename(t *testing.T) {
	old := "/Users/test/Desktop/Screenshot.png"
	cases := []struct {
		newName string
		want    string
		wantErr bool
	}{
		{"deploy-bug", "/Users/test/Desktop/deploy-bug.png", false},
		{"deploy-bug.png", "/Users/test/Desktop/deploy-bug.png", false},
		{"deploy-bug.PNG", "/Users/test/Desktop/deploy-bug.PNG", false},
		{"shot.v2", "/Users/test/Desktop/shot.v2.png", false},
		{"  spaced  ", "/Users/test/Desktop/spaced.png", false},
		{"", "", true},
		{"   ", "", true},
		{"a/b", "", true},
		{"../escape", "", true},
		{"bad:name", "", true},
		{".hidden", "", true},
		{"..", "", true},
	}
	for _, tc := range cases {
		got, err := validateCaptureRename(old, tc.newName)
		if tc.wantErr {
			if err == nil {
				t.Errorf("validateCaptureRename(%q): expected error, got %q", tc.newName, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("validateCaptureRename(%q): unexpected error %v", tc.newName, err)
			continue
		}
		if got != tc.want {
			t.Errorf("validateCaptureRename(%q) = %q, want %q", tc.newName, got, tc.want)
		}
	}
}

func TestCapturesEqual(t *testing.T) {
	a := []CaptureFile{{Path: "/d/a.png", Size: 10, ModifiedAt: 1}, {Path: "/d/b.mov", Size: 20, ModifiedAt: 2}}
	same := []CaptureFile{{Path: "/d/a.png", Size: 10, ModifiedAt: 1}, {Path: "/d/b.mov", Size: 20, ModifiedAt: 2}}
	if !capturesEqual(a, same) {
		t.Error("identical scans should be equal")
	}
	if !capturesEqual(nil, nil) {
		t.Error("two empty scans should be equal")
	}
	added := append([]CaptureFile{{Path: "/d/c.png", Size: 5, ModifiedAt: 3}}, a...)
	if capturesEqual(a, added) {
		t.Error("added file should not be equal")
	}
	touched := []CaptureFile{{Path: "/d/a.png", Size: 10, ModifiedAt: 9}, a[1]}
	if capturesEqual(a, touched) {
		t.Error("changed mtime should not be equal")
	}
	resized := []CaptureFile{{Path: "/d/a.png", Size: 11, ModifiedAt: 1}, a[1]}
	if capturesEqual(a, resized) {
		t.Error("changed size should not be equal")
	}
}

func TestUniqueCapturePath(t *testing.T) {
	dir := t.TempDir()
	free := filepath.Join(dir, "Screenshot.png")
	if got := uniqueCapturePath(free); got != free {
		t.Errorf("free path should be returned as-is, got %q", got)
	}
	if err := os.WriteFile(free, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, "Screenshot 2.png")
	if got := uniqueCapturePath(free); got != want {
		t.Errorf("first collision suffix = %q, want %q", got, want)
	}
	if err := os.WriteFile(want, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	want3 := filepath.Join(dir, "Screenshot 3.png")
	if got := uniqueCapturePath(free); got != want3 {
		t.Errorf("second collision suffix = %q, want %q", got, want3)
	}
}

func TestDecodeDataURI(t *testing.T) {
	cases := []struct {
		name    string
		dataURI string
		want    string
		wantErr bool
	}{
		{"png", "data:image/png;base64,aGVsbG8=", "hello", false},
		{"jpeg", "data:image/jpeg;base64,d29ybGQ=", "world", false},
		{"missing prefix", "aGVsbG8=", "", true},
		{"missing base64 marker", "data:image/png,aGVsbG8=", "", true},
		{"invalid base64 payload", "data:image/png;base64,not-base64!!", "", true},
		{"empty", "", "", true},
	}
	for _, tc := range cases {
		got, err := decodeDataURI(tc.dataURI)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: decodeDataURI(%q) = %q, nil; want error", tc.name, tc.dataURI, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: decodeDataURI(%q) unexpected error: %v", tc.name, tc.dataURI, err)
			continue
		}
		if string(got) != tc.want {
			t.Errorf("%s: decodeDataURI(%q) = %q, want %q", tc.name, tc.dataURI, got, tc.want)
		}
	}
}
