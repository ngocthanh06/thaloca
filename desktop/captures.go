package main

// Captures: manage macOS screenshots and screen recordings from inside
// Thaloca. macOS drops captures wherever `com.apple.screencapture location`
// points (~/Desktop by default), where they pile up unmanaged. This view
// lists the media files in that folder, keeps the list fresh with a short
// poll (no fsnotify dependency — same poll-loop pattern as documents.go,
// just a faster tick since a single readdir is cheap), and offers per-file
// open / reveal / edit / rename / move-to-Trash plus an opt-in switch of
// the capture location to a dedicated folder.

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	capturesPollInterval = 3 * time.Second
	// 192px thumbnails: retina-friendly for a ~96pt grid cell while staying
	// small enough (tens of KB base64) to send lazily per file — never
	// embedded in the snapshot, which would balloon it to multiple MB.
	captureThumbnailSize = "192"
)

var captureImageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".heic": true, ".gif": true,
}

var captureVideoExtensions = map[string]bool{
	".mov": true, ".mp4": true,
}

func captureEditableInApp(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".png" || ext == ".jpg" || ext == ".jpeg"
}

// CaptureFile is one screenshot or screen recording in the capture folder.
type CaptureFile struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"` // "image" | "video"
	Size       int64   `json:"size"`
	ModifiedAt float64 `json:"modified_at"` // unix seconds, same convention as ManagedDocument
}

// CapturesSnapshot is what the frontend renders. Unlike DocumentSnapshot
// there is no persisted library behind it — the filesystem is the source
// of truth, so every snapshot is a fresh directory listing.
type CapturesSnapshot struct {
	Location        string        `json:"location"`
	DedicatedFolder string        `json:"dedicated_folder"`
	UsingDedicated  bool          `json:"using_dedicated"`
	Captures        []CaptureFile `json:"captures"`
	Error           string        `json:"error,omitempty"`
}

// captureThumb is one cached thumbnail; modifiedAt/size identify the file
// contents it was generated from so an edited file regenerates.
type captureThumb struct {
	modifiedAt float64
	size       int64
	dataURI    string
}

// captureKind classifies a file extension as "image", "video", or "" for
// anything that is not a capture media type. Detection is deliberately an
// extension allowlist over the capture folder rather than filename patterns
// (locale-dependent: "Screenshot …" is "Ảnh chụp Màn hình …" on a
// Vietnamese system) or Spotlight metadata (needs indexing, one process per
// file, and screen recordings are never tagged kMDItemIsScreenCapture).
func captureKind(ext string) string {
	ext = strings.ToLower(ext)
	if captureImageExtensions[ext] {
		return "image"
	}
	if captureVideoExtensions[ext] {
		return "video"
	}
	return ""
}

func dedicatedCaptureFolder(home string) string {
	return filepath.Join(home, "Pictures", "Thaloca Captures")
}

// resolveCaptureLocation normalizes raw `defaults read` output: trims
// whitespace, expands a leading "~", and falls back to <home>/Desktop (the
// macOS default) when the value is missing, relative, or unusable.
func resolveCaptureLocation(raw, home string) string {
	loc := strings.TrimSpace(raw)
	if loc == "~" {
		loc = home
	} else if strings.HasPrefix(loc, "~/") {
		loc = filepath.Join(home, loc[2:])
	}
	if loc == "" || !filepath.IsAbs(loc) {
		return filepath.Join(home, "Desktop")
	}
	return filepath.Clean(loc)
}

// scanCaptureFolder lists capture media directly in dir — non-recursive,
// skipping subdirectories and dotfiles (in-progress captures are written
// under a leading-dot temp name until finished). Newest first.
func scanCaptureFolder(dir string) ([]CaptureFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := []CaptureFile{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") {
			continue
		}
		kind := captureKind(filepath.Ext(name))
		if kind == "" {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, CaptureFile{
			Path:       filepath.Join(dir, name),
			Name:       name,
			Kind:       kind,
			Size:       info.Size(),
			ModifiedAt: float64(info.ModTime().UnixNano()) / 1e9,
		})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].ModifiedAt != files[j].ModifiedAt {
			return files[i].ModifiedAt > files[j].ModifiedAt
		}
		return files[i].Name < files[j].Name
	})
	return files, nil
}

// capturesEqual reports whether two scans describe the same set of files —
// the poll loop's change detector.
func capturesEqual(a, b []CaptureFile) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Path != b[i].Path || a[i].Size != b[i].Size || a[i].ModifiedAt != b[i].ModifiedAt {
			return false
		}
	}
	return true
}

// validateCaptureRename validates a new base name for oldPath and returns
// the full target path in the same directory. The original extension is
// enforced (case-insensitively) so a rename can never change what kind of
// file macOS and this view think it is.
func validateCaptureRename(oldPath, newName string) (string, error) {
	name := strings.TrimSpace(newName)
	if name == "" {
		return "", fmt.Errorf("a file name is required")
	}
	if strings.ContainsAny(name, "/:\x00") || filepath.Base(name) != name {
		return "", fmt.Errorf(`file name cannot contain "/" or ":"`)
	}
	if strings.HasPrefix(name, ".") {
		return "", fmt.Errorf("file name cannot start with a dot")
	}
	ext := filepath.Ext(oldPath)
	if !strings.EqualFold(filepath.Ext(name), ext) {
		name += ext
	}
	return filepath.Join(filepath.Dir(oldPath), name), nil
}

// uniqueCapturePath returns path itself if nothing exists there, otherwise
// the first "name 2.ext", "name 3.ext", … that is free — used only by the
// bulk migration in UseDedicatedCaptureFolder; an explicit rename rejects
// collisions instead so the user picks the name.
func uniqueCapturePath(path string) string {
	if _, err := os.Lstat(path); err != nil {
		return path
	}
	ext := filepath.Ext(path)
	stem := strings.TrimSuffix(path, ext)
	for i := 2; i < 1000; i++ {
		candidate := fmt.Sprintf("%s %d%s", stem, i, ext)
		if _, err := os.Lstat(candidate); err != nil {
			return candidate
		}
	}
	return path
}

// readCaptureLocation asks macOS where captures are currently saved. The
// key simply not existing (the common, never-customized case) makes
// `defaults read` exit non-zero — that and any other failure fall through
// to the ~/Desktop default.
func (a *App) readCaptureLocation() string {
	home, _ := os.UserHomeDir()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw := ""
	if out, err := exec.CommandContext(ctx, "defaults", "read", "com.apple.screencapture", "location").Output(); err == nil {
		raw = string(out)
	}
	return resolveCaptureLocation(raw, home)
}

// writeCaptureLocation points macOS at a new capture folder. The follow-up
// killall makes SystemUIServer re-read the preference; recent macOS picks
// it up without that, and killall exits non-zero when the process isn't
// running — both fine, so its result is ignored.
func writeCaptureLocation(dir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "defaults", "write", "com.apple.screencapture", "location", dir).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	_ = exec.Command("killall", "SystemUIServer").Run()
	return nil
}

func (a *App) capturesSnapshot(loc string, files []CaptureFile, scanErr error) CapturesSnapshot {
	home, _ := os.UserHomeDir()
	dedicated := dedicatedCaptureFolder(home)
	if files == nil {
		files = []CaptureFile{}
	}
	snapshot := CapturesSnapshot{
		Location:        loc,
		DedicatedFolder: dedicated,
		UsingDedicated:  loc == dedicated,
		Captures:        files,
	}
	if scanErr != nil {
		snapshot.Error = fmt.Sprintf("cannot read %s: %v — if macOS denied access, allow Thaloca under System Settings → Privacy & Security → Files and Folders", loc, scanErr)
	}
	return snapshot
}

// ListCaptures returns the current capture folder listing and refreshes the
// poll loop's baseline so a UI-triggered refresh doesn't re-emit an event
// for a state the frontend already has.
func (a *App) ListCaptures() CapturesSnapshot {
	loc := a.readCaptureLocation()
	files, err := scanCaptureFolder(loc)
	a.capturesMu.Lock()
	a.capturesLocation = loc
	a.capturesLast = files
	a.capturesMu.Unlock()
	return a.capturesSnapshot(loc, files, err)
}

func (a *App) emitCapturesChanged(snapshot CapturesSnapshot) {
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "captures-changed", snapshot)
	}
}

// pollCapturesLoop keeps the Captures view near-real-time: one tiny
// readdir every 3 seconds and refreshes the macOS preference every 30
// seconds to notice out-of-band location changes. It emits only when
// something changed, so a fresh ⇧⌘4 screenshot appears within one tick.
func (a *App) pollCapturesLoop() {
	a.pollCapturesOnce(true)
	ticker := time.NewTicker(capturesPollInterval)
	defer ticker.Stop()
	ticks := 0
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			ticks++
			// Readdir stays responsive every 3s, while the external `defaults`
			// process is only spawned every 30s to notice an out-of-band
			// screenshot-location change.
			a.pollCapturesOnce(ticks%10 == 0)
		}
	}
}

func (a *App) pollCapturesOnce(refreshLocation bool) {
	a.capturesMu.Lock()
	loc := a.capturesLocation
	a.capturesMu.Unlock()
	if refreshLocation || loc == "" {
		loc = a.readCaptureLocation()
	}
	files, err := scanCaptureFolder(loc)
	a.capturesMu.Lock()
	changed := loc != a.capturesLocation || !capturesEqual(files, a.capturesLast)
	a.capturesLocation = loc
	a.capturesLast = files
	a.capturesMu.Unlock()
	if !changed {
		return
	}
	a.pruneCaptureThumbs(files)
	a.emitCapturesChanged(a.capturesSnapshot(loc, files, err))
}

// managedCapturePath allows only an existing regular media file sitting
// directly in the current capture folder — same access model as
// managedDocumentPath, except membership is derived from the live
// directory since captures have no persisted library.
func (a *App) managedCapturePath(path string) bool {
	path = filepath.Clean(path)
	name := filepath.Base(path)
	if strings.HasPrefix(name, ".") || captureKind(filepath.Ext(name)) == "" {
		return false
	}
	a.capturesMu.Lock()
	loc := a.capturesLocation
	a.capturesMu.Unlock()
	if loc == "" {
		loc = a.readCaptureLocation()
	}
	if filepath.Dir(path) != loc {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func (a *App) OpenCapture(path string) error {
	if !a.managedCapturePath(path) {
		return fmt.Errorf("file is not in the captures folder")
	}
	return exec.Command("open", path).Run()
}

func (a *App) RevealCapture(path string) error {
	if !a.managedCapturePath(path) {
		return fmt.Errorf("file is not in the captures folder")
	}
	return exec.Command("open", "-R", path).Run()
}

func (a *App) CopyCaptureFile(path string) error {
	if !a.managedCapturePath(path) {
		return fmt.Errorf("file is not in the captures folder")
	}
	return copyCaptureToClipboard(path, false)
}

func (a *App) CopyCaptureImage(path string) error {
	if !a.managedCapturePath(path) || captureKind(filepath.Ext(path)) != "image" {
		return fmt.Errorf("file is not an image in the captures folder")
	}
	return copyCaptureToClipboard(path, true)
}

func (a *App) CaptureOCR(path string) (string, error) {
	if !a.managedCapturePath(path) || captureKind(filepath.Ext(path)) != "image" {
		return "", fmt.Errorf("file is not an image in the captures folder")
	}
	return recognizeCaptureText(path)
}

// EditCapture opens the file in an editor. Images go to Preview explicitly
// (the default handler for PNG may be a browser, which can't annotate);
// videos use the default handler (QuickTime Player unless the user chose a
// different editor — which is exactly what they'd want opened).
func (a *App) EditCapture(path string) error {
	if !a.managedCapturePath(path) {
		return fmt.Errorf("file is not in the captures folder")
	}
	if captureKind(filepath.Ext(path)) == "image" {
		return exec.Command("open", "-a", "Preview", path).Run()
	}
	return exec.Command("open", path).Run()
}

// decodeDataURI extracts the raw bytes from a "data:<mime>;base64,<data>"
// URI, as produced by canvas.toBlob() + FileReader on the frontend.
func decodeDataURI(dataURI string) ([]byte, error) {
	const marker = ";base64,"
	idx := strings.Index(dataURI, marker)
	if !strings.HasPrefix(dataURI, "data:") || idx < 0 {
		return nil, fmt.Errorf("not a base64 data URI")
	}
	data, err := base64.StdEncoding.DecodeString(dataURI[idx+len(marker):])
	if err != nil {
		return nil, fmt.Errorf("invalid base64 payload: %w", err)
	}
	return data, nil
}

// LoadCaptureImage returns a capture image's full-resolution bytes as a
// base64 data URI — the full-quality counterpart to CaptureThumbnail (which
// is capped at captureThumbnailSize), used to load the image into the
// in-app markup editor.
func (a *App) LoadCaptureImage(path string) (string, error) {
	if !a.managedCapturePath(path) || captureKind(filepath.Ext(path)) != "image" {
		return "", fmt.Errorf("file is not an image in the captures folder")
	}
	if !captureEditableInApp(path) {
		return "", fmt.Errorf("the in-app editor supports PNG and JPEG only; open this file in Preview to preserve its format")
	}
	data, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	mime := "image/png"
	if ext := strings.ToLower(filepath.Ext(path)); ext == ".jpg" || ext == ".jpeg" {
		mime = "image/jpeg"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// SaveEditedCapture overwrites an image capture in place with edited bytes
// from the in-app markup editor. It writes to a temp file in the same
// directory first, then renames over the original — atomic, so a failed
// write never leaves a half-written file behind.
func (a *App) SaveEditedCapture(path, dataURI string) (CapturesSnapshot, error) {
	if !a.managedCapturePath(path) || captureKind(filepath.Ext(path)) != "image" {
		return a.ListCaptures(), fmt.Errorf("file is not an image in the captures folder")
	}
	if !captureEditableInApp(path) {
		return a.ListCaptures(), fmt.Errorf("cannot overwrite this format from the in-app editor; use Save As to preserve the original")
	}
	data, err := decodeDataURI(dataURI)
	if err != nil {
		return a.ListCaptures(), err
	}
	path = filepath.Clean(path)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".thaloca-capture-edit-*")
	if err != nil {
		return a.ListCaptures(), err
	}
	tmpPath := tmp.Name()
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		os.Remove(tmpPath)
		if writeErr != nil {
			return a.ListCaptures(), writeErr
		}
		return a.ListCaptures(), closeErr
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return a.ListCaptures(), err
	}
	a.captureThumbMu.Lock()
	delete(a.captureThumbs, path)
	a.captureThumbMu.Unlock()
	snapshot := a.ListCaptures()
	a.emitCapturesChanged(snapshot)
	return snapshot, nil
}

// SaveEditedCaptureAs exports the edited image to a new location chosen via
// a native save dialog, leaving the original file untouched. Returns ""
// (with a nil error) if the user cancels the dialog.
func (a *App) SaveEditedCaptureAs(path, dataURI, suggestedName string) (string, error) {
	if !a.managedCapturePath(path) || captureKind(filepath.Ext(path)) != "image" {
		return "", fmt.Errorf("file is not an image in the captures folder")
	}
	data, err := decodeDataURI(dataURI)
	if err != nil {
		return "", err
	}
	target, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		Title:            "Save edited capture",
		DefaultDirectory: filepath.Dir(path),
		DefaultFilename:  suggestedName,
	})
	if err != nil || target == "" {
		return "", err
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return "", err
	}
	if filepath.Dir(target) == filepath.Dir(path) {
		a.emitCapturesChanged(a.ListCaptures())
	}
	return target, nil
}

func (a *App) RenameCapture(path, newName string) (CapturesSnapshot, error) {
	if !a.managedCapturePath(path) {
		return a.ListCaptures(), fmt.Errorf("file is not in the captures folder")
	}
	path = filepath.Clean(path)
	target, err := validateCaptureRename(path, newName)
	if err != nil {
		return a.ListCaptures(), err
	}
	if target == path {
		return a.ListCaptures(), nil
	}
	if _, err := os.Lstat(target); err == nil {
		return a.ListCaptures(), fmt.Errorf("a file named %q already exists", filepath.Base(target))
	}
	if err := os.Rename(path, target); err != nil {
		return a.ListCaptures(), err
	}
	a.captureThumbMu.Lock()
	if thumb, ok := a.captureThumbs[path]; ok {
		delete(a.captureThumbs, path)
		a.captureThumbs[target] = thumb
	}
	a.captureThumbMu.Unlock()
	snapshot := a.ListCaptures()
	a.emitCapturesChanged(snapshot)
	return snapshot, nil
}

// DeleteCapture moves a capture to the Trash via Finder (not a permanent
// rm), so a mis-click is recoverable with Put Back — same pattern as
// DeleteInstalledApp.
func (a *App) DeleteCapture(path string) (CapturesSnapshot, error) {
	if !a.managedCapturePath(path) {
		return a.ListCaptures(), fmt.Errorf("file is not in the captures folder")
	}
	path = filepath.Clean(path)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Pass the path as argv rather than interpolating it into AppleScript, so
	// quotes, backslashes and other valid filename characters stay data and
	// can never alter the script.
	//
	// The POSIX file coercion must happen in a plain "set" statement before
	// the "tell" block: resolving it inline as an argument to a Finder
	// command (e.g. "tell application \"Finder\" to delete POSIX file (item
	// 1 of argv)") sends the unresolved expression to Finder itself, which
	// fails with "Can't get POSIX file ... (-1728)" even when the file
	// exists.
	script := `on run argv
set targetFile to POSIX file (item 1 of argv)
tell application "Finder" to delete targetFile
end run`
	out, err := exec.CommandContext(ctx, "osascript", "-e", script, path).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if message == "" {
			message = err.Error()
		}
		return a.ListCaptures(), fmt.Errorf("%s", message)
	}
	a.captureThumbMu.Lock()
	delete(a.captureThumbs, path)
	a.captureThumbMu.Unlock()
	snapshot := a.ListCaptures()
	a.emitCapturesChanged(snapshot)
	return snapshot, nil
}

// CaptureThumbnail lazily generates (and caches) one file's thumbnail as a
// base64 PNG data URI. Called per row from the frontend after the list
// renders, keeping ListCaptures itself instant.
func (a *App) CaptureThumbnail(path string) (string, error) {
	if !a.managedCapturePath(path) {
		return "", fmt.Errorf("file is not in the captures folder")
	}
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	modifiedAt := float64(info.ModTime().UnixNano()) / 1e9
	a.captureThumbMu.Lock()
	if a.captureThumbs == nil {
		a.captureThumbs = map[string]captureThumb{}
	}
	if cached, ok := a.captureThumbs[path]; ok && cached.modifiedAt == modifiedAt && cached.size == info.Size() {
		a.captureThumbMu.Unlock()
		return cached.dataURI, nil
	}
	a.captureThumbMu.Unlock()

	uri, err := generateCaptureThumbnail(path)
	if err != nil {
		return "", err
	}
	a.captureThumbMu.Lock()
	a.captureThumbs[path] = captureThumb{modifiedAt: modifiedAt, size: info.Size(), dataURI: uri}
	a.captureThumbMu.Unlock()
	return uri, nil
}

// generateCaptureThumbnail renders one thumbnail via Quick Look
// (`qlmanage -t`), which handles both images and video poster frames with
// one code path. Images additionally fall back to sips (the readAppIcon
// pattern) when Quick Look fails; a video with no thumbnail just keeps the
// frontend's placeholder glyph — best-effort, like app icons.
func generateCaptureThumbnail(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tmpDir, err := os.MkdirTemp("", "thaloca-capture-thumb-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmpDir)

	if err := exec.CommandContext(ctx, "qlmanage", "-t", "-s", captureThumbnailSize, "-o", tmpDir, path).Run(); err == nil {
		// qlmanage names its output "<base name>.png" (so "Shot.png.png") —
		// read whatever single PNG landed rather than guessing the name.
		if uri := readThumbnailDir(tmpDir); uri != "" {
			return uri, nil
		}
	}
	if captureKind(filepath.Ext(path)) == "image" {
		tmpPath := filepath.Join(tmpDir, "thaloca-sips-thumb.png")
		if err := exec.CommandContext(ctx, "sips", "-s", "format", "png", "-Z", captureThumbnailSize, path, "--out", tmpPath).Run(); err == nil {
			if data, err := os.ReadFile(tmpPath); err == nil && len(data) > 0 {
				return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data), nil
			}
		}
	}
	return "", fmt.Errorf("no thumbnail available")
}

func readThumbnailDir(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".png") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil || len(data) == 0 {
			continue
		}
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	}
	return ""
}

func (a *App) pruneCaptureThumbs(files []CaptureFile) {
	a.captureThumbMu.Lock()
	defer a.captureThumbMu.Unlock()
	if len(a.captureThumbs) == 0 {
		return
	}
	live := make(map[string]bool, len(files))
	for _, file := range files {
		live[file.Path] = true
	}
	for path := range a.captureThumbs {
		if !live[path] {
			delete(a.captureThumbs, path)
		}
	}
}

func (a *App) PickCaptureFolder() (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "Choose a captures folder"})
}

// SetCaptureFolder points macOS at an existing folder of the user's choice.
// Reverting to the macOS default is just picking ~/Desktop again — no
// separate revert binding.
func (a *App) SetCaptureFolder(path string) (CapturesSnapshot, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return a.ListCaptures(), fmt.Errorf("a folder is required")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return a.ListCaptures(), err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return a.ListCaptures(), fmt.Errorf("folder does not exist")
	}
	if err := writeCaptureLocation(abs); err != nil {
		return a.ListCaptures(), err
	}
	snapshot := a.ListCaptures()
	a.emitCapturesChanged(snapshot)
	return snapshot, nil
}

// UseDedicatedCaptureFolder switches the macOS capture location to
// ~/Pictures/Thaloca Captures (creating it if needed) and optionally moves
// the existing captures over. Only ever called after the user confirmed in
// a native dialog — it changes system-wide behavior.
func (a *App) UseDedicatedCaptureFolder(moveExisting bool) (CapturesSnapshot, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return a.ListCaptures(), err
	}
	dedicated := dedicatedCaptureFolder(home)
	oldLocation := a.readCaptureLocation()
	if err := os.MkdirAll(dedicated, 0o755); err != nil {
		return a.ListCaptures(), err
	}
	if err := writeCaptureLocation(dedicated); err != nil {
		return a.ListCaptures(), err
	}
	moveFailures := 0
	if moveExisting && oldLocation != dedicated {
		if files, err := scanCaptureFolder(oldLocation); err == nil {
			for _, file := range files {
				target := uniqueCapturePath(filepath.Join(dedicated, file.Name))
				if err := os.Rename(file.Path, target); err != nil {
					moveFailures++
				}
			}
		}
	}
	snapshot := a.ListCaptures()
	if moveFailures > 0 && snapshot.Error == "" {
		snapshot.Error = fmt.Sprintf("%d file(s) could not be moved from %s — they remain there", moveFailures, oldLocation)
	}
	a.emitCapturesChanged(snapshot)
	return snapshot, nil
}
