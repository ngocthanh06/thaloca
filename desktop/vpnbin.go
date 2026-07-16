package main

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// vpnBinFS embeds the real WireGuard (wg, wg-quick, wireguard-go), bundled
// GNU bash (needed only to run wg-quick — see bashPath in
// serverVPNWireGuard.go), and OpenVPN (openvpn + its lzo/lz4/openssl/
// pkcs11-helper dylib dependencies) binaries — relocated by the fetch
// script to reference each other via relative @executable_path/@loader_path
// paths instead of Homebrew's own, unresolved-outside-`brew install`
// @@HOMEBREW_PREFIX@@ paths — fetched and checksum-verified by
// scripts/fetch-vpn-binaries.sh. This directory is gitignored; running that
// script is a required one-time step before `go build`/`wails build` will
// succeed here, the same as `npm install` already is for the frontend.
//
//go:embed vpnbin/darwin_arm64/wg vpnbin/darwin_arm64/wg-quick vpnbin/darwin_arm64/wireguard-go vpnbin/darwin_arm64/bash vpnbin/darwin_arm64/openvpn vpnbin/darwin_arm64/lib
var vpnBinFS embed.FS

const vpnBinSourceDir = "vpnbin/darwin_arm64"

var vpnBinNames = []string{"wg", "wg-quick", "wireguard-go", "bash", "openvpn"}

// vpnLibNames are dependency dylibs extracted alongside the binaries above
// in a "lib" subdirectory — OpenVPN's (lzo/lz4/openssl/pkcs11-helper) and
// bundled bash's (readline/history/ncursesw/intl, needed because macOS's
// own /bin/bash is stuck on 3.2, too old for wg-quick's `declare -A` use —
// see bashPath). Every load command referencing these (rewritten by the
// fetch script via install_name_tool) points at @executable_path/lib/<name>
// or @loader_path/<name>, i.e. relative to wherever the binary/dylib itself
// ends up (vpnBinDir()).
var vpnLibNames = []string{
	"liblzo2.2.dylib", "liblz4.1.dylib", "libssl.3.dylib", "libcrypto.3.dylib", "libpkcs11-helper.1.dylib",
	"libreadline.8.dylib", "libhistory.8.dylib", "libncursesw.6.dylib", "libintl.8.dylib",
}

// vpnBinDir returns ~/.thaloca/bin, extracting the embedded VPN binaries
// into it (and OpenVPN's dylibs into its "lib" subdirectory) first if
// they're missing or stale (compared by content hash, so a Thaloca upgrade
// with newer bundled binaries replaces them automatically). wg-quick's own
// script adds its own directory to PATH at startup and looks up
// wireguard-go the same way (confirmed by reading its source) — so keeping
// all three WireGuard files together in one directory is sufficient;
// nothing else needs to set PATH or an env var override.
func vpnBinDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".thaloca", "bin")
	libDir := filepath.Join(dir, "lib")
	if err := os.MkdirAll(libDir, 0o755); err != nil {
		return "", err
	}
	for _, name := range vpnBinNames {
		if err := extractIfStale(vpnBinSourceDir+"/"+name, filepath.Join(dir, name)); err != nil {
			return "", err
		}
	}
	for _, name := range vpnLibNames {
		if err := extractIfStale(vpnBinSourceDir+"/lib/"+name, filepath.Join(libDir, name)); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// embeddedSHA256 returns the lowercase hex SHA-256 of an embedded file —
// the trusted expected hash the privileged VPN staging script verifies its
// root-owned copies against (see vpnStageScript in serverVPN.go). Hashing
// the embedded bytes rather than the extracted files under vpnBinDir()
// matters: the extraction lives in the user's home and is only ever the
// copy *source*, never the integrity reference.
func embeddedSHA256(embeddedPath string) (string, error) {
	data, err := vpnBinFS.ReadFile(embeddedPath)
	if err != nil {
		return "", fmt.Errorf("embedded %s missing from build: %w", embeddedPath, err)
	}
	return sha256Hex(data), nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func extractIfStale(embeddedPath, target string) error {
	embedded, err := vpnBinFS.ReadFile(embeddedPath)
	if err != nil {
		return fmt.Errorf("embedded %s missing from build: %w", embeddedPath, err)
	}
	if upToDate(target, embedded) {
		return nil
	}
	return os.WriteFile(target, embedded, 0o755)
}

// upToDate reports whether target already holds exactly wanted's bytes, so
// a Thaloca upgrade with newer bundled binaries replaces them but a normal
// run doesn't re-write (and re-chmod) them on every single call — this
// runs on every ConnectServerVPN/ListVPNEngines call.
func upToDate(target string, wanted []byte) bool {
	existing, err := os.ReadFile(target)
	if err != nil {
		return false
	}
	return bytes.Equal(existing, wanted)
}
