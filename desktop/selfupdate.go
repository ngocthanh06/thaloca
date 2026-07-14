package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// selfUpdateAssetName is the release asset desktop/build/package-dmg.sh
// produces specifically for PerformSelfUpdate — a plain zip of the .app
// bundle (via `ditto`), separate from Thaloca.dmg which stays for anyone
// who prefers the familiar manual download.
const selfUpdateAssetName = "Thaloca.app.zip"

// latestReleaseAsset asks GitHub for updateRepo's latest release (same
// endpoint CheckForUpdate in updates.go already uses) and returns the
// direct download URL for selfUpdateAssetName.
func latestReleaseAsset() (downloadURL string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+updateRepo+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub returned %d checking for the latest release", resp.StatusCode)
	}

	var release struct {
		Assets []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", err
	}

	for _, asset := range release.Assets {
		if asset.Name == selfUpdateAssetName {
			return asset.BrowserDownloadURL, nil
		}
	}
	return "", fmt.Errorf("latest release doesn't have a %s asset", selfUpdateAssetName)
}

// currentAppBundlePath resolves the .app bundle currently running this
// process from os.Executable() (.../Thaloca.app/Contents/MacOS/Thaloca),
// refusing to proceed if it isn't actually inside an .app bundle (e.g.
// running via `wails dev`) or its parent directory isn't writable (e.g.
// still running straight out of a mounted, read-only .dmg instead of an
// installed copy) — self-update only ever touches the bundle after these
// checks pass.
func currentAppBundlePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	// .../Thaloca.app/Contents/MacOS/Thaloca -> .../Thaloca.app
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if filepath.Ext(bundle) != ".app" {
		return "", fmt.Errorf("not running from an installed .app bundle — self-update isn't available in this environment")
	}

	parent := filepath.Dir(bundle)
	probe, err := os.CreateTemp(parent, ".thaloca-update-check-*")
	if err != nil {
		return "", fmt.Errorf("%s isn't writable — move Thaloca to /Applications and try again", parent)
	}
	probe.Close()
	os.Remove(probe.Name())
	return bundle, nil
}

// findAppBundle returns the path of the single ".app" directory directly
// inside dir.
func findAppBundle(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.EqualFold(filepath.Ext(entry.Name()), ".app") {
			return filepath.Join(dir, entry.Name()), nil
		}
	}
	return "", fmt.Errorf("no .app directory found in %s", dir)
}

func downloadFile(url, dest string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

// PerformSelfUpdate downloads the latest release's Thaloca.app.zip,
// extracts it, and hands off to a small detached script that waits for
// this process to exit, swaps the old .app for the new one, strips any
// quarantine flag, and relaunches it — then quits the app so the script
// can proceed. Every failure up to that handoff returns an error without
// touching the currently-installed app at all; only called after the
// frontend's own confirm dialog (see settingsPanel.ts).
func (a *App) PerformSelfUpdate() error {
	bundle, err := currentAppBundlePath()
	if err != nil {
		return err
	}

	downloadURL, err := latestReleaseAsset()
	if err != nil {
		return err
	}

	workDir, err := os.MkdirTemp("", "thaloca-update-*")
	if err != nil {
		return err
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(workDir)
		}
	}()

	zipPath := filepath.Join(workDir, selfUpdateAssetName)
	if err := downloadFile(downloadURL, zipPath); err != nil {
		return fmt.Errorf("could not download update: %w", err)
	}

	extractDir := filepath.Join(workDir, "extracted")
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		return err
	}
	if out, err := exec.Command("/usr/bin/ditto", "-x", "-k", zipPath, extractDir).CombinedOutput(); err != nil {
		return fmt.Errorf("could not extract update: %s", strings.TrimSpace(string(out)))
	}

	// Found by scanning extractDir for the single ".app" entry rather than
	// assuming its name matches filepath.Base(bundle) exactly — macOS's
	// default case-insensitive-but-case-preserving filesystem means the
	// currently-installed bundle (e.g. "/Applications/Thaloca.app") and
	// what `wails build`/ditto actually produced ("thaloca.app") can differ
	// only in case, which would silently break a case-sensitive volume.
	newBundle, err := findAppBundle(extractDir)
	if err != nil {
		return fmt.Errorf("downloaded update didn't contain an .app bundle: %w", err)
	}

	// Runs detached, after this process has already quit: wait for our PID
	// to disappear, swap the bundle, strip quarantine defensively (a plain
	// Go net/http download doesn't set com.apple.quarantine the way a
	// browser download does, but this costs nothing), relaunch, then clean
	// up the temp working directory.
	scriptPath := filepath.Join(workDir, "swap.sh")
	script := fmt.Sprintf(`#!/bin/sh
while kill -0 %d 2>/dev/null; do sleep 0.2; done
rm -rf %s
mv %s %s
xattr -cr %s
open %s
rm -rf %s
`, os.Getpid(), shellQuote(bundle), shellQuote(newBundle), shellQuote(bundle), shellQuote(bundle), shellQuote(bundle), shellQuote(workDir))
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		return err
	}

	cmd := exec.Command("/bin/sh", scriptPath)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not launch updater: %w", err)
	}

	success = true
	wailsruntime.Quit(a.ctx)
	return nil
}
