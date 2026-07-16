package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

const (
	selfUpdateAssetName         = "Thaloca.app.zip"
	selfUpdateChecksumAssetName = "Thaloca.app.zip.sha256"
	selfUpdateMaxBytes          = 300 << 20 // 300 MiB, comfortably above the current app.
)

type selfUpdateRelease struct {
	Version     string
	DownloadURL string
	ChecksumURL string
	SHA256      string
}

// latestSelfUpdateRelease resolves the exact ZIP published on GitHub's latest
// release. GitHub's asset digest is preferred; the separately published
// .sha256 file is the compatibility fallback for API responses without it.
func latestSelfUpdateRelease() (selfUpdateRelease, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+updateRepo+"/releases/latest", nil)
	if err != nil {
		return selfUpdateRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return selfUpdateRelease{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return selfUpdateRelease{}, fmt.Errorf("GitHub returned %d checking for the latest release", resp.StatusCode)
	}
	return parseSelfUpdateRelease(resp.Body)
}

func parseSelfUpdateRelease(r io.Reader) (selfUpdateRelease, error) {
	var payload struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Digest             string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(r).Decode(&payload); err != nil {
		return selfUpdateRelease{}, err
	}
	result := selfUpdateRelease{Version: strings.TrimPrefix(payload.TagName, "v")}
	for _, asset := range payload.Assets {
		switch asset.Name {
		case selfUpdateAssetName:
			result.DownloadURL = asset.BrowserDownloadURL
			if digest, ok := normalizedSHA256(asset.Digest); ok {
				result.SHA256 = digest
			}
		case selfUpdateChecksumAssetName:
			result.ChecksumURL = asset.BrowserDownloadURL
		}
	}
	if result.Version == "" {
		return selfUpdateRelease{}, fmt.Errorf("latest release has no version tag")
	}
	if result.DownloadURL == "" {
		return selfUpdateRelease{}, fmt.Errorf("latest release doesn't have a %s asset", selfUpdateAssetName)
	}
	if result.SHA256 == "" && result.ChecksumURL == "" {
		return selfUpdateRelease{}, fmt.Errorf("latest release has no SHA-256 for %s", selfUpdateAssetName)
	}
	return result, nil
}

func normalizedSHA256(value string) (string, bool) {
	value = strings.TrimSpace(strings.TrimPrefix(value, "sha256:"))
	decoded, err := hex.DecodeString(value)
	return strings.ToLower(value), err == nil && len(decoded) == sha256.Size
}

func checksumFromFile(data []byte) (string, error) {
	fields := strings.Fields(string(data))
	if len(fields) < 1 {
		return "", fmt.Errorf("checksum file is empty")
	}
	digest, ok := normalizedSHA256(fields[0])
	if !ok {
		return "", fmt.Errorf("checksum file does not contain a valid SHA-256")
	}
	if len(fields) >= 2 && strings.TrimPrefix(fields[1], "*") != selfUpdateAssetName {
		return "", fmt.Errorf("checksum file describes %q instead of %s", fields[1], selfUpdateAssetName)
	}
	return digest, nil
}

func downloadBytes(url string, maxBytes int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download returned status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("download exceeds the %d-byte limit", maxBytes)
	}
	return data, nil
}

func downloadFileWithSHA256(url, dest string, maxBytes int64) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download returned status %d", resp.StatusCode)
	}
	if resp.ContentLength > maxBytes {
		return "", fmt.Errorf("download is larger than the %d-byte limit", maxBytes)
	}

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(out, hash), io.LimitReader(resp.Body, maxBytes+1))
	closeErr := out.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n > maxBytes {
		return "", fmt.Errorf("download exceeds the %d-byte limit", maxBytes)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// currentAppBundlePath resolves the running .app and checks that its parent
// is writable. Self-update is deliberately unavailable under `wails dev`, on
// a mounted DMG, or wherever the app cannot safely stage a sibling bundle.
func currentAppBundlePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if !strings.EqualFold(filepath.Ext(bundle), ".app") {
		return "", fmt.Errorf("not running from an installed .app bundle — self-update isn't available in this environment")
	}
	parent := filepath.Dir(bundle)
	probe, err := os.CreateTemp(parent, ".thaloca-update-check-*")
	if err != nil {
		return "", fmt.Errorf("%s isn't writable — move Thaloca to /Applications and try again", parent)
	}
	probeName := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probeName)
	return bundle, nil
}

// findAppBundle accepts exactly one top-level, real .app directory. Refusing
// archives with extra bundles avoids choosing an arbitrary payload.
func findAppBundle(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var found []string
	for _, entry := range entries {
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && strings.EqualFold(filepath.Ext(entry.Name()), ".app") {
			found = append(found, filepath.Join(dir, entry.Name()))
		}
	}
	if len(found) != 1 {
		return "", fmt.Errorf("expected exactly one .app directory in the update, found %d", len(found))
	}
	return found[0], nil
}

func verifyUpdateBundle(currentBundle, newBundle, expectedVersion string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	current, currentOK := readAppInfo(ctx, currentBundle)
	next, nextOK := readAppInfo(ctx, newBundle)
	if !currentOK || !nextOK {
		return fmt.Errorf("could not read the app bundle metadata")
	}
	if next.BundleID != current.BundleID {
		return fmt.Errorf("update bundle ID %q does not match %q", next.BundleID, current.BundleID)
	}
	if next.Version != expectedVersion {
		return fmt.Errorf("update bundle version %q does not match release %q", next.Version, expectedVersion)
	}
	if out, err := exec.CommandContext(ctx, "/usr/bin/codesign", "--verify", "--deep", "--strict", newBundle).CombinedOutput(); err != nil {
		return fmt.Errorf("update signature verification failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// PerformSelfUpdate downloads and verifies the latest release, stages its app
// beside the installed bundle, then starts a detached swap script. The script
// keeps a backup and rolls back if the final rename fails; the current app is
// untouched until every download/extraction/identity/signature check passes.
func (a *App) PerformSelfUpdate(expectedVersion string) error {
	if a.ctx == nil {
		return fmt.Errorf("application is not ready")
	}
	bundle, err := currentAppBundlePath()
	if err != nil {
		return err
	}
	release, err := latestSelfUpdateRelease()
	if err != nil {
		return err
	}
	if release.Version != expectedVersion {
		return fmt.Errorf("latest release changed from %s to %s — check for updates again before installing", expectedVersion, release.Version)
	}
	if !isNewerVersion(release.Version, AppVersion) {
		return fmt.Errorf("release %s is not newer than installed version %s", release.Version, AppVersion)
	}
	expectedHash := release.SHA256
	if expectedHash == "" {
		checksumData, downloadErr := downloadBytes(release.ChecksumURL, 1<<20)
		if downloadErr != nil {
			return fmt.Errorf("could not download update checksum: %w", downloadErr)
		}
		expectedHash, err = checksumFromFile(checksumData)
		if err != nil {
			return err
		}
	}

	workDir, err := os.MkdirTemp("", "thaloca-update-*")
	if err != nil {
		return err
	}
	keepWorkDir := false
	defer func() {
		if !keepWorkDir {
			_ = os.RemoveAll(workDir)
		}
	}()
	zipPath := filepath.Join(workDir, selfUpdateAssetName)
	actualHash, err := downloadFileWithSHA256(release.DownloadURL, zipPath, selfUpdateMaxBytes)
	if err != nil {
		return fmt.Errorf("could not download update: %w", err)
	}
	if !strings.EqualFold(actualHash, expectedHash) {
		return fmt.Errorf("update checksum mismatch: expected %s, got %s", expectedHash, actualHash)
	}

	extractDir := filepath.Join(workDir, "extracted")
	if err := os.MkdirAll(extractDir, 0o700); err != nil {
		return err
	}
	if out, extractErr := exec.Command("/usr/bin/ditto", "-x", "-k", zipPath, extractDir).CombinedOutput(); extractErr != nil {
		return fmt.Errorf("could not extract update: %s", strings.TrimSpace(string(out)))
	}
	newBundle, err := findAppBundle(extractDir)
	if err != nil {
		return fmt.Errorf("downloaded update is invalid: %w", err)
	}
	if err := verifyUpdateBundle(bundle, newBundle, release.Version); err != nil {
		return err
	}

	parent := filepath.Dir(bundle)
	stagePath, err := os.MkdirTemp(parent, ".thaloca-update-stage-*")
	if err != nil {
		return fmt.Errorf("could not create update staging path: %w", err)
	}
	if err := os.Remove(stagePath); err != nil {
		return err
	}
	if out, stageErr := exec.Command("/usr/bin/ditto", newBundle, stagePath).CombinedOutput(); stageErr != nil {
		_ = os.RemoveAll(stagePath)
		return fmt.Errorf("could not stage update: %s", strings.TrimSpace(string(out)))
	}
	if err := verifyUpdateBundle(bundle, stagePath, release.Version); err != nil {
		_ = os.RemoveAll(stagePath)
		return err
	}

	backupPath := bundle + ".thaloca-backup"
	scriptPath := filepath.Join(workDir, "swap.sh")
	script := fmt.Sprintf(`#!/bin/sh
while kill -0 %d 2>/dev/null; do sleep 0.2; done
rm -rf %s
if ! mv %s %s; then rm -rf %s; exit 1; fi
if mv %s %s; then
  open %s
  rm -rf %s
else
  mv %s %s
  open %s
fi
rm -rf %s
`, os.Getpid(), shellQuote(backupPath), shellQuote(bundle), shellQuote(backupPath), shellQuote(stagePath), shellQuote(stagePath), shellQuote(bundle), shellQuote(bundle), shellQuote(backupPath), shellQuote(backupPath), shellQuote(bundle), shellQuote(bundle), shellQuote(workDir))
	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		_ = os.RemoveAll(stagePath)
		return err
	}
	cmd := exec.Command("/bin/sh", scriptPath)
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(stagePath)
		return fmt.Errorf("could not launch updater: %w", err)
	}
	keepWorkDir = true
	wailsruntime.Quit(a.ctx)
	return nil
}
