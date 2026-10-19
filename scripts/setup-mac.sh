#!/usr/bin/env bash
# One-time setup for building DeskPal on macOS.
# Installs (only if missing): Xcode Command Line Tools, Rust (rustup), Node deps.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }

step "Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  echo "already installed: $(xcode-select -p)"
else
  echo "Installing — a macOS dialog will open. Re-run this script when it finishes."
  xcode-select --install || true
  exit 0
fi

step "Rust"
if command -v cargo >/dev/null 2>&1; then
  echo "already installed: $(rustc --version)"
else
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

step "Node.js"
if command -v node >/dev/null 2>&1; then
  echo "already installed: node $(node -v)"
else
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "Node.js is missing. Install the LTS from https://nodejs.org (or Homebrew), then re-run." >&2
    exit 1
  fi
fi

step "Project dependencies"
npm install

step "Done"
cat <<'EOF'
Run the app in development mode (first build takes a few minutes):

    npm run dev

Build a release .app / .dmg:

    npm run build      # → src-tauri/target/release/bundle/

Design the UI in a normal browser, without Rust:

    npm run preview    # → http://localhost:5173/pet.html
EOF
