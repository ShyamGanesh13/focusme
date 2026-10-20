# FocusMe — project guide for Claude Code

A macOS desktop-companion ("desk pet") built with **Tauri 2 (Rust) + vanilla JS**
(no bundler, no Electron). The pet floats over everything — including other apps'
full-screen Spaces — on **every monitor**, and nudges you about water, reminders,
routines and focus sessions. Crate name is `deskpal`; product name is **FocusMe**;
bundle id `com.shyamganesh.deskpal`.

## Run / build / test

```bash
./scripts/setup-mac.sh        # one-time: Xcode CLT + Rust + npm install
npm run dev                   # dev build (foreground; rebuilds on save)
cd src-tauri && cargo test    # 17 unit tests (ask.rs parsers, scheduler windows, sys)
npm run build                 # release .app + .dmg in src-tauri/target/release/bundle
./scripts/install-mac.sh      # build + install to ~/Applications + relaunch (the "ship it" path)
npm run preview               # frontend only, in a browser, against lib/bridge.js mock
```

The installed `~/Applications/FocusMe.app` is a frozen build — re-run `install-mac.sh`
to update it. Unsigned, so first launch may need right-click → Open.

## Architecture

- `src/pet.html|css|js` — the overlay: pet behavior, chat box, speech bubble, peek mode.
  `pet.js` owns everything visible; a `requestAnimationFrame` loop drives motion and the
  peek slide. Geometry is per-window (`window.innerWidth/Height`), so the same file runs
  unchanged in each monitor's overlay.
- `src/settings.html|css|js` — settings window (Pet, Character, Focus, Reminders, Notes,
  Wellbeing, General). Changes save debounced via `save_config`.
- `src/lib/` — `character.js` (SVG sanitize + part animation), `bridge.js` (Tauri invoke/
  listen + an in-browser mock used by `npm run preview`), `chime.js`.
- `src-tauri/src/`
  - `main.rs` — app wiring + `invoke_handler` (register new commands here).
  - `overlay.rs` — **one overlay window per monitor** (`reconcile_pets`, called at startup
    and every 2s), per-monitor fit, NSPanel pinning over full-screen (`pin_above_everything`),
    per-window hit-testing (`hit_loop`), tray menu, settings window, `focus_for_input`.
  - `scheduler.rs` — 1-second heartbeat: focus sessions, one-off reminders, **daily**
    reminders, **routines**, water, bedtime. Emits app-wide events the pets listen for.
  - `ask.rs` — chat brain (no LLM): `classify` → shape, `intent` (questions), `command`
    (`/…`), the `/every` and `/daily` parsers, and `help()`.
  - `state.rs` — `Config` (+ `Default`), `Runtime`, persistence to
    `~/Library/Application Support/com.shyamganesh.deskpal/{config.json,notes.json}` and
    `character.svg`. Per-window hit map + `visible` flag live on `AppState`.
  - `when.rs` (natural-language time), `sys.rs` (battery/mem/cpu/disk/…), `weather.rs` (Open-Meteo).

## Key behaviors / design notes

- **Overlay pinning (overlay.rs):** the NSWindow is re-classed to a non-activating
  `NSPanel`, level `NSScreenSaverWindowLevel` (1000), collection behavior
  `canJoinAllSpaces | fullScreenAuxiliary` (NOT `stationary` — that pins it to the desktop
  Space and keeps it off full-screen Spaces). AppKit calls must run on the main thread
  (`run_on_main_thread`). A one-time log prints `applied level=… behavior=257 panel=true`.
- **Multi-monitor:** `reconcile_pets` keeps the config `pet` window on the primary display
  and creates `pet-2`, `pet-3`, … on the others at their work-area origin; closes overlays
  when a monitor is unplugged. Events are app-wide so every pet reacts together.
- **Peek mode** (`pet.peek`, default on): the pet rests off-screen and slides up only for a
  nudge / chat / menu, controlled by `wantShown()` + a `peekUntil` timestamp. It stays out
  for the whole focus session (badge visible). In peek mode it never enters the idle-doze
  loop.
- **Three reminder kinds:** one-off `Reminder{at}`, `DailyReminder{time}` (fires once/day at
  HH:MM), `Routine{every_minutes}` (interval). Routine/daily fire-tracking is in-memory
  (`Runtime.routine_last` / `daily_fired`) so **intervals reset on app restart** — fine for
  the always-on installed app, surprising during dev restarts.
- **Chat bubble** is anchored to the pet's right edge (pet lives bottom-right) and wraps,
  so it never clips off the right screen edge.
- **Login item** on by default (`Config.login_item`, synced to the OS each launch).

## Conventions

- Frontend is served as-is (no build step). **No `localStorage`/browser storage** in the
  overlay — it isn't reliable there; keep state in Rust (`config.json`) or JS memory.
- After editing Rust, `cargo test` (fast) before building the app.
- To add a chat command: add a `Command` variant + parse arm in `ask.rs`, handle it in
  `commands.rs::run_command`, and update `help()`.
- To add a scheduled thing: add to `Config`/`Runtime` in `state.rs`, fire it in
  `scheduler.rs::beat`, surface it in `settings.*`, and (optionally) a `/command`.

## State as of this handoff

- Working, committed: full-screen overlay, multi-monitor (verified on 2 displays), peek
  mode, focus sessions + pause/snooze, one-off + daily + routine reminders, water, bedtime,
  chat with inline action buttons, clear-chat, login item, `install-mac.sh`.
- Remote is `github.com/ShyamGanesh13/focusme` (branch `main`). Push with a PAT.
- Roadmap left (see README): browser-tab budget, **auto-update** for the installed app,
  signed/notarised releases, Windows build.
