#!/bin/sh
# Fetches the real, checksum-verified Homebrew bottles needed for Thaloca's
# bundled VPN engines (macOS arm64) — including a bundled GNU bash, since
# wg-quick requires bash 4+ and macOS's own /bin/bash is stuck on 3.2 — and
# populates desktop/vpnbin/darwin_arm64/,
# which desktop/vpnbin.go then //go:embeds into Thaloca itself — no Homebrew
# required on the end user's Mac. Must be re-run whenever these formulae are
# upgraded; desktop/vpnbin/ is gitignored, so this is a required one-time step
# before `go build`/`wails build` will succeed (the go:embed directives fail
# to compile with no files present), the same way `npm install` already is
# for the frontend.
set -e

# arm64_sonoma is the oldest arm64 bottle tag every formula here currently
# publishes (per formulae.brew.sh) — the broadest-compatibility choice, since
# Homebrew bottles are built to run on that macOS version and newer.
BOTTLE_TAG="arm64_sonoma"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/vpnbin/darwin_arm64"
LICENSE_DIR="$OUT_DIR/../licenses"
# vpn-binaries.lock pins each formula's exact bottle URL + SHA-256 and is
# committed to the repo (unlike vpnbin/ itself) — so two machines building
# the same commit always bundle byte-identical binaries instead of whatever
# "current stable" happens to be at each build time. Run with REFRESH_LOCK=1
# to deliberately re-resolve the latest stable bottles from the Homebrew API
# and rewrite the lock, then commit the updated lock.
LOCK_FILE="$(cd "$(dirname "$0")" && pwd)/vpn-binaries.lock"
TAB="$(printf '\t')"
mkdir -p "$OUT_DIR" "$OUT_DIR/lib" "$LICENSE_DIR"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# fetch_bottle formula [ghcr_name] — resolves formula's bottle URL+SHA-256
# from the committed lock file (or, with REFRESH_LOCK=1 / a missing entry
# while refreshing, from the Homebrew API — updating the lock), downloads
# and checksum-verifies it, extracts into $WORK_DIR, and echoes that Cellar
# dir's path. ghcr_name is only needed when it differs from the formula's
# own name (e.g. "openssl@3" is fetched from ghcr.io's "openssl/3" repo).
fetch_bottle() {
  formula="$1"
  ghcr_name="${2:-$1}"

  url=""
  expected_sha256=""
  if [ "${REFRESH_LOCK:-0}" != "1" ] && [ -f "$LOCK_FILE" ]; then
    entry="$(grep "^${formula}${TAB}" "$LOCK_FILE" | head -n 1 || true)"
    if [ -n "$entry" ]; then
      url="$(printf '%s' "$entry" | cut -f2)"
      expected_sha256="$(printf '%s' "$entry" | cut -f3)"
    fi
  fi

  if [ -z "$url" ] || [ -z "$expected_sha256" ]; then
    if [ "${REFRESH_LOCK:-0}" != "1" ]; then
      echo "$formula is not pinned in $LOCK_FILE — run REFRESH_LOCK=1 $0 to regenerate the lock, then commit it" >&2
      exit 1
    fi
    info_json="$(curl -fsSL "https://formulae.brew.sh/api/formula/${formula}.json")"
    url="$(printf '%s' "$info_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
files = data['bottle']['stable']['files']
print(files['$BOTTLE_TAG']['url'])
")"
    expected_sha256="$(printf '%s' "$info_json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
files = data['bottle']['stable']['files']
print(files['$BOTTLE_TAG']['sha256'])
")"
    if [ -z "$url" ] || [ -z "$expected_sha256" ]; then
      echo "Could not resolve $BOTTLE_TAG bottle for $formula" >&2
      exit 1
    fi
    { [ -f "$LOCK_FILE" ] && grep -v "^${formula}${TAB}" "$LOCK_FILE" || true; } > "$LOCK_FILE.tmp"
    printf '%s\t%s\t%s\n' "$formula" "$url" "$expected_sha256" >> "$LOCK_FILE.tmp"
    sort "$LOCK_FILE.tmp" > "$LOCK_FILE"
    rm -f "$LOCK_FILE.tmp"
    echo "Pinned $formula in $(basename "$LOCK_FILE") — remember to commit the lock" >&2
  fi

  token="$(curl -fsSL "https://ghcr.io/token?scope=repository:homebrew/core/${ghcr_name}:pull" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")"
  archive="$WORK_DIR/$(echo "$formula" | tr '@/' '__').tar.gz"
  curl -fsSL -H "Authorization: Bearer $token" "$url" -o "$archive" >&2

  actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    echo "Checksum mismatch for $formula: expected $expected_sha256, got $actual_sha256" >&2
    exit 1
  fi
  echo "Fetched $formula, checksum verified ($actual_sha256)" >&2

  extract_dir="$WORK_DIR/extracted-$(echo "$formula" | tr '@/' '__')"
  mkdir -p "$extract_dir"
  tar xzf "$archive" -C "$extract_dir"
  find "$extract_dir" -mindepth 2 -maxdepth 2 -type d
}

save_license() {
  name="$1"
  cellar_dir="$2"
  src_file="$3"
  cp "$cellar_dir/$src_file" "$LICENSE_DIR/${name}.LICENSE"
  basename "$cellar_dir" > "$LICENSE_DIR/${name}.version"
}

echo "== WireGuard (wg, wg-quick, wireguard-go) =="
wgtools_dir="$(fetch_bottle wireguard-tools)"
wggo_dir="$(fetch_bottle wireguard-go)"

cp "$wgtools_dir/bin/wg" "$OUT_DIR/wg"
cp "$wgtools_dir/bin/wg-quick" "$OUT_DIR/wg-quick"
cp "$wggo_dir/bin/wireguard-go" "$OUT_DIR/wireguard-go"
chmod 0755 "$OUT_DIR/wg" "$OUT_DIR/wg-quick" "$OUT_DIR/wireguard-go"
save_license "wireguard-tools" "$wgtools_dir" "COPYING"
save_license "wireguard-go" "$wggo_dir" "LICENSE"

echo "== bash (wg-quick needs bash 4+; macOS ships 3.2) =="
bash_dir="$(fetch_bottle bash)"
readline_dir="$(fetch_bottle readline)"
ncurses_dir="$(fetch_bottle ncurses)"
gettext_dir="$(fetch_bottle gettext)"

cp "$bash_dir/bin/bash" "$OUT_DIR/bash"
cp "$readline_dir/lib/libreadline.8.dylib" "$OUT_DIR/lib/libreadline.8.dylib"
cp "$readline_dir/lib/libhistory.8.dylib" "$OUT_DIR/lib/libhistory.8.dylib"
cp "$ncurses_dir/lib/libncursesw.6.dylib" "$OUT_DIR/lib/libncursesw.6.dylib"
cp "$gettext_dir/lib/libintl.8.dylib" "$OUT_DIR/lib/libintl.8.dylib"
chmod u+w "$OUT_DIR/bash" "$OUT_DIR/lib/libreadline.8.dylib" "$OUT_DIR/lib/libhistory.8.dylib" "$OUT_DIR/lib/libncursesw.6.dylib" "$OUT_DIR/lib/libintl.8.dylib"

# Same @@HOMEBREW_PREFIX@@ relocation dance as OpenVPN below — bash and its
# 3 dylibs only ever reference each other and system frameworks/libs
# (confirmed via otool -L: readline/history depend on macOS's own
# /usr/lib/libncurses, and libintl depends only on system libiconv/
# CoreFoundation/CoreServices — none of that needs bundling).
install_name_tool -id "@loader_path/libreadline.8.dylib" "$OUT_DIR/lib/libreadline.8.dylib"
install_name_tool -id "@loader_path/libhistory.8.dylib" "$OUT_DIR/lib/libhistory.8.dylib"
install_name_tool -id "@loader_path/libncursesw.6.dylib" "$OUT_DIR/lib/libncursesw.6.dylib"
install_name_tool -id "@loader_path/libintl.8.dylib" "$OUT_DIR/lib/libintl.8.dylib"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/readline/lib/libreadline.8.dylib" "@executable_path/lib/libreadline.8.dylib" "$OUT_DIR/bash"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/readline/lib/libhistory.8.dylib" "@executable_path/lib/libhistory.8.dylib" "$OUT_DIR/bash"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/ncurses/lib/libncursesw.6.dylib" "@executable_path/lib/libncursesw.6.dylib" "$OUT_DIR/bash"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/gettext/lib/libintl.8.dylib" "@executable_path/lib/libintl.8.dylib" "$OUT_DIR/bash"

codesign --force -s - "$OUT_DIR/lib/libreadline.8.dylib" "$OUT_DIR/lib/libhistory.8.dylib" "$OUT_DIR/lib/libncursesw.6.dylib" "$OUT_DIR/lib/libintl.8.dylib" "$OUT_DIR/bash"
chmod 0755 "$OUT_DIR/bash" "$OUT_DIR/lib/libreadline.8.dylib" "$OUT_DIR/lib/libhistory.8.dylib" "$OUT_DIR/lib/libncursesw.6.dylib" "$OUT_DIR/lib/libintl.8.dylib"
save_license "bash" "$bash_dir" "COPYING"
save_license "readline" "$readline_dir" "COPYING"
save_license "ncurses" "$ncurses_dir" "COPYING"
save_license "gettext" "$gettext_dir" "COPYING"

echo "== Verifying the relocated bash actually runs standalone =="
"$OUT_DIR/bash" --version

echo "== OpenVPN (+ its lzo/lz4/openssl@3/pkcs11-helper deps) =="
lzo_dir="$(fetch_bottle lzo)"
lz4_dir="$(fetch_bottle lz4)"
openssl_dir="$(fetch_bottle openssl@3 openssl/3)"
pkcs11_dir="$(fetch_bottle pkcs11-helper)"
openvpn_dir="$(fetch_bottle openvpn)"

cp "$openvpn_dir/sbin/openvpn" "$OUT_DIR/openvpn"
cp "$lzo_dir/lib/liblzo2.2.dylib" "$OUT_DIR/lib/liblzo2.2.dylib"
# liblz4.1.dylib in the bottle is a symlink to the real versioned file —
# copy the file it points to under the name openvpn's load command expects.
cp -L "$lz4_dir/lib/liblz4.1.dylib" "$OUT_DIR/lib/liblz4.1.dylib"
cp "$openssl_dir/lib/libssl.3.dylib" "$OUT_DIR/lib/libssl.3.dylib"
cp "$openssl_dir/lib/libcrypto.3.dylib" "$OUT_DIR/lib/libcrypto.3.dylib"
cp "$pkcs11_dir/lib/libpkcs11-helper.1.dylib" "$OUT_DIR/lib/libpkcs11-helper.1.dylib"
chmod u+w "$OUT_DIR/openvpn" "$OUT_DIR"/lib/*.dylib

# The bottled openvpn/its dylibs all reference each other via unresolved
# @@HOMEBREW_PREFIX@@/@@HOMEBREW_CELLAR@@ placeholders (Homebrew's own
# `brew install` normally rewrites these at install time) — since we're
# extracting outside of `brew install`, rewrite them ourselves to relative
# @executable_path/@loader_path references so the bundle is fully
# self-contained, verified by actually running the result below.
install_name_tool -id "@loader_path/liblzo2.2.dylib" "$OUT_DIR/lib/liblzo2.2.dylib"
install_name_tool -id "@loader_path/liblz4.1.dylib" "$OUT_DIR/lib/liblz4.1.dylib"
install_name_tool -id "@loader_path/libcrypto.3.dylib" "$OUT_DIR/lib/libcrypto.3.dylib"
install_name_tool -id "@loader_path/libssl.3.dylib" "$OUT_DIR/lib/libssl.3.dylib"
install_name_tool -change "@@HOMEBREW_CELLAR@@/openssl@3/$(basename "$openssl_dir")/lib/libcrypto.3.dylib" "@loader_path/libcrypto.3.dylib" "$OUT_DIR/lib/libssl.3.dylib"
install_name_tool -id "@loader_path/libpkcs11-helper.1.dylib" "$OUT_DIR/lib/libpkcs11-helper.1.dylib"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libcrypto.3.dylib" "@loader_path/libcrypto.3.dylib" "$OUT_DIR/lib/libpkcs11-helper.1.dylib"

install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/lzo/lib/liblzo2.2.dylib" "@executable_path/lib/liblzo2.2.dylib" "$OUT_DIR/openvpn"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/lz4/lib/liblz4.1.dylib" "@executable_path/lib/liblz4.1.dylib" "$OUT_DIR/openvpn"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/pkcs11-helper/lib/libpkcs11-helper.1.dylib" "@executable_path/lib/libpkcs11-helper.1.dylib" "$OUT_DIR/openvpn"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libssl.3.dylib" "@executable_path/lib/libssl.3.dylib" "$OUT_DIR/openvpn"
install_name_tool -change "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libcrypto.3.dylib" "@executable_path/lib/libcrypto.3.dylib" "$OUT_DIR/openvpn"

# install_name_tool invalidates the bottle's existing (Homebrew-applied)
# code signature — re-sign ad-hoc, the same signing Thaloca.app itself
# already ships with (no paid Apple Developer ID), so these run standalone.
codesign --force -s - "$OUT_DIR"/lib/*.dylib "$OUT_DIR/openvpn"

chmod 0755 "$OUT_DIR/openvpn" "$OUT_DIR"/lib/*.dylib
save_license "openvpn" "$openvpn_dir" "COPYING"
save_license "lzo" "$lzo_dir" "COPYING"
save_license "lz4" "$lz4_dir" "LICENSE"
save_license "openssl" "$openssl_dir" "LICENSE.txt"
save_license "pkcs11-helper" "$pkcs11_dir" "COPYING.BSD"

echo "== Verifying the relocated openvpn actually runs standalone =="
"$OUT_DIR/openvpn" --version

echo "Done. Bundled files in $OUT_DIR:"
find "$OUT_DIR" -type f | sort
