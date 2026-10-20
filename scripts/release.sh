#!/usr/bin/env bash
#
# Publish a new FocusMe release for friends.
#
#   ./scripts/release.sh 0.2.0
#
# Bumps the version, commits, tags v0.2.0 and pushes. GitHub Actions
# (.github/workflows/release.yml) then builds the app and puts FocusMe.zip on
# https://github.com/ShyamGanesh13/focusme/releases/latest (~5–10 min).
# Installed copies notice the new version within a day and show an Update bubble.
#
set -euo pipefail
cd "$(dirname "$0")/.."

V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: $0 X.Y.Z   (current: $(node -p "require('./src-tauri/tauri.conf.json').version"))" >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "✗ Commit or stash your changes first." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$V" >/dev/null && { echo "✗ v$V already exists." >&2; exit 1; }

# Edit only the top-level "version" line so the files keep their formatting.
for f in src-tauri/tauri.conf.json package.json; do
  sed -i '' -E "1,/\"version\"/ s/(\"version\": *\")[^\"]*\"/\1$V\"/" "$f"
done
npm install --package-lock-only --silent

git add src-tauri/tauri.conf.json package.json package-lock.json
git commit -q -m "Release v$V"
git tag "v$V"
git push -q origin HEAD "v$V"

echo "✓ Pushed v$V. GitHub is building it now:"
echo "  https://github.com/ShyamGanesh13/focusme/actions"
echo "  Friends download from: https://github.com/ShyamGanesh13/focusme/releases/latest"
