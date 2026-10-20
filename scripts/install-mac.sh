#!/usr/bin/env bash
#
# Build FocusMe as a real macOS app, install it to ~/Applications, and launch it.
# (~/Applications, not /Applications: no admin rights needed, and some managed
# Macs block writes to /Applications.)
# After this you never need a terminal again: FocusMe runs in the menu bar as a
# background app, survives closing the terminal, and (with "Open at login" on,
# the default) relaunches after a restart.
#
# Usage:  ./scripts/install-mac.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck disable=SC1090
. "$HOME/.cargo/env" 2>/dev/null || true

APP_NAME="FocusMe.app"
BUNDLE="src-tauri/target/release/bundle/macos/$APP_NAME"
DEST="$HOME/Applications/$APP_NAME"

echo "▶ Building $APP_NAME (release) — this takes a few minutes the first time…"
# Only the .app is needed to install; the .dmg step is slow and flaky (hdiutil "Resource busy").
npx tauri build --bundles app

if [ ! -d "$BUNDLE" ]; then
  echo "✗ Build output not found at $BUNDLE" >&2
  exit 1
fi

echo "▶ Quitting any running FocusMe so the new build takes over…"
osascript -e 'quit app "FocusMe"' >/dev/null 2>&1 || true
pkill -f "FocusMe.app/Contents/MacOS/deskpal" >/dev/null 2>&1 || true
sleep 1

echo "▶ Installing to $DEST…"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$BUNDLE" "$DEST"

echo "▶ Launching the new build…"
open -n "$DEST"

cat <<'DONE'

✓ FocusMe is installed and running in the menu bar.
  • You can close this terminal — it keeps running on its own.
  • It relaunches automatically when you log in (Settings → General → "Open at login").
  • Quit it anytime from the menu-bar icon or the pet's menu.

To update later, just run this script again.
DONE
