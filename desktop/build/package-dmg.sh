#!/bin/bash
# Packages the already-built thaloca.app into a distributable .dmg, plus a
# plain .app.zip plus its SHA-256 file for manual release downloads.
# Run `wails build` first — this script only wraps whatever is currently in
# build/bin/thaloca.app, it doesn't build the app itself.
#
# Uses hdiutil (built into macOS) rather than a third-party tool like
# create-dmg, so packaging needs no extra dependency beyond Xcode's command
# line tools.
#
# IMPORTANT: `wails build`'s own signing step is ad-hoc (`codesign --sign -`),
# not a real Apple Developer ID signature. A .dmg built from that will still
# trigger Gatekeeper's "cannot be opened because it is from an unidentified
# developer" warning for anyone who downloads it — they'll need to right-click
# the app and choose Open once, or run:
#   xattr -cr /Applications/Thaloca.app
# Distributing without a Gatekeeper warning requires an Apple Developer ID
# ($99/year) and notarizing the .dmg via `xcrun notarytool` — not set up here.

set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Thaloca"
APP_PATH="build/bin/${APP_NAME}.app"
DMG_PATH="build/bin/${APP_NAME}.dmg"
ZIP_PATH="build/bin/${APP_NAME}.app.zip"
ZIP_CHECKSUM_PATH="${ZIP_PATH}.sha256"
VOL_NAME="${APP_NAME}"

if [ ! -d "$APP_PATH" ]; then
  echo "error: $APP_PATH not found — run 'wails build' first." >&2
  exit 1
fi

# License notices must accompany the bundled GPL/MIT/BSD/Apache VPN
# binaries. Add them before distribution, then refresh the ad-hoc signature
# because modifying Contents/Resources invalidates Wails' build signature.
LICENSE_DIR="$APP_PATH/Contents/Resources/Licenses"
mkdir -p "$LICENSE_DIR"
cp ../LICENSE "$LICENSE_DIR/Thaloca-LICENSE.txt"
cp THIRD_PARTY_LICENSES.md "$LICENSE_DIR/THIRD_PARTY_LICENSES.md"
cp THIRD_PARTY_SOURCE.md "$LICENSE_DIR/THIRD_PARTY_SOURCE.md"
cp scripts/vpn-binaries.lock "$LICENSE_DIR/vpn-binaries.lock"
cp scripts/fetch-vpn-binaries.sh "$LICENSE_DIR/fetch-vpn-binaries.sh"
codesign --force --deep --sign - "$APP_PATH"

rm -f "$DMG_PATH" "$ZIP_PATH" "$ZIP_CHECKSUM_PATH"

STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT

# Wails' output directory is physically named `thaloca.app`; stage it under
# the product-cased name users should see. ditto preserves bundle xattrs,
# symlinks, and the ad-hoc signature while copying.
ditto "$APP_PATH" "$STAGING_DIR/$APP_NAME.app"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGING_DIR" -ov -format UDZO "$DMG_PATH"

echo "Built $DMG_PATH"

# Plain .app.zip for users who prefer it to the DMG. ditto (not `zip`) is
# macOS's own tool for this, since it preserves the
# resource forks/xattrs/symlinks inside an .app bundle correctly in both
# directions (ditto -c to zip, ditto -x to unzip).
ditto -c -k --keepParent "$STAGING_DIR/$APP_NAME.app" "$ZIP_PATH"
shasum -a 256 "$ZIP_PATH" > "$ZIP_CHECKSUM_PATH"

echo "Built $ZIP_PATH"
echo "Built $ZIP_CHECKSUM_PATH"
