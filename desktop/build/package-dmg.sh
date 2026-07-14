#!/bin/bash
# Packages the already-built thaloca.app into a distributable .dmg, plus a
# plain .app.zip (see below) for the in-app self-updater.
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
VOL_NAME="${APP_NAME}"

if [ ! -d "$APP_PATH" ]; then
  echo "error: $APP_PATH not found — run 'wails build' first." >&2
  exit 1
fi

rm -f "$DMG_PATH" "$ZIP_PATH"

STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT

cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create -volname "$VOL_NAME" -srcfolder "$STAGING_DIR" -ov -format UDZO "$DMG_PATH"

echo "Built $DMG_PATH"

# Plain .app.zip for desktop/selfupdate.go to download and swap in place —
# ditto (not `zip`) is macOS's own tool for this, since it preserves the
# resource forks/xattrs/symlinks inside an .app bundle correctly in both
# directions (ditto -c to zip, ditto -x to unzip).
ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"

echo "Built $ZIP_PATH"
