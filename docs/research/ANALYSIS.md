# FocusCat — Reverse-Engineering Teardown

Target: **FocusCat 3.0.0** by Gokul (gokulbuilds.com/focuscat) — a Windows desktop-pet/companion app.
Analysed: 2026-10-19 · Tooling: REA 6.7.0 (`rea-agents`), 7-Zip, pefile, brotli, the in-app browser.
Nothing was executed — the installer and the app binary were only unpacked and read.

| Artifact | SHA-256 |
|---|---|
| `FocusCat_3.0.0_x64-setup.exe` (1,951,766 B, NSIS) | `13941934eb06295fdb3512cc99d331ecccefe22d8336fcc30f1421c9caca4c25` |
| `focuscat.exe` (7,120,896 B, PE32+ x86-64) | `674d4e3993a479906b2a3c4dbc0a7c01c248555827f660b08742d8b4d511fe40` |

---

## 1. TL;DR

- **Stack:** Tauri **2.11.5** (Rust) + WebView2. The frontend is vanilla JS + inline SVG, animated with **GSAP 3.15 + MorphSVGPlugin**. There's no framework and no bundler.
- **The cat** is a hand-authored, procedural SVG rig (≈20 paths). Every pose is a list of points turned into a Catmull-Rom path, and MorphSVG blends between poses. There are no sprites or videos.
- **The "AI" chat has no LLM.** It's a keyword intent matcher in Rust (`ask.rs`). A line is classified by its shape: `/cmd` runs a command, `…?` asks a question, anything else is saved as a note.
- **Tab policing** uses Win32 + **UI Automation**. It polls the foreground window, reads the browser address bar via `IUIAutomationValuePattern`, and keeps per-site time budgets for the active window only. When a budget runs out the cat climbs to the tab bar and closes the tab with **Ctrl+W** (`SendInput`). If that's blocked it falls back to **UIA InvokePattern** on the tab's X button, and then to closing the window.
- **System answers** come straight from Win32 APIs: battery, memory per app, disk, CPU, uptime, internet. Weather uses Windows Location → BigDataCloud reverse geocoding → Open-Meteo.
- **Persistence** is a single `config.json`, plus an HKCU `Run` key for "Start with Windows".

## 2. Evidence trail (how this was obtained)

1. **Landing page** (`/focuscat/`): read its scripts through the browser. `focuscat.js` says the page runs *"the real rig out of the app"*, and comments mention `pet.js`, `ask.rs` and a settings window. That points to a Tauri app.
2. **Installer:** `7z x` on the NSIS setup produced `focuscat.exe`, `LICENSE`, and `$PLUGINSDIR/nsis_tauri_utils.dll`. That DLL is the Tauri bundler's signature.
3. **Embedded frontend:** Tauri 2 stores each asset as `<path string><brotli stream>` in `.rdata`. A small carver (`docs/research/scripts/extract_tauri_assets.py`) recovered **14 files**. Five shared files hash-match the website copies byte for byte (`cat-rig.js`, `cat-shapes.js`, `cat.css`, `gsap.min.js`, `MorphSVGPlugin.min.js`). `cat.js` in the app is slightly newer (44,678 B vs 43,346 B on the site).
4. **REA runs** (Evidence JSON in `docs/research/rea-evidence/`):
   - `inspect-rust-binary`: PE x86-64 Rust, rustc commit `48a229ce…`, no cargo-auditable metadata.
   - `inspect-artifact` / `inspect-pe-resources`: PE inventory, icon groups.
   - `analyze-javascript-application` on the extracted frontend: 8 JS files parsed, 72,877 AST nodes, 0 parse failures. It found **0 Electron IPC channels**, which confirms the app isn't Electron. The IPC is Tauri `invoke`/`listen` (mapped by hand in §5).
   - `inspect-binary-layout` needs a pwntools provider, which isn't installed. It was skipped.
5. **Imports + strings** on `focuscat.exe` (pefile/strings): Win32 APIs, endpoints, intent keyword tables, UI copy, and COM GUIDs (CUIAutomation, IUIAutomation, ValuePattern, InvokePattern found at fixed offsets).

## 3. Architecture

```
┌──────────────────────── focuscat.exe (Rust, Tauri 2) ────────────────────────┐
│ watcher loop (pollMs 1000 / urlPollMs 1500)                                  │
│   GetForegroundWindow → GetWindowThreadProcessId → QueryFullProcessImageNameW │
│   → is it a browser? (chrome msedge firefox brave opera vivaldi arc chromium │
│      librewolf zen opera_gx) → UIA: address bar ValuePattern → URL           │
│   → match against cfg.sites[].url → accrue seconds (foreground only)          │
│   → budget hit → emit "bust" to the pet window                               │
│ act(): SetForegroundWindow + SendInput(Ctrl+W) │ UIA InvokePattern on tab X   │
│        │ close window — reports which one worked                              │
│ ask.rs: classify(line) → intent tables → answer {title, lines[]}             │
│ sysinfo: GetSystemPowerStatus, GlobalMemoryStatusEx, K32EnumProcesses +      │
│   K32GetProcessMemoryInfo (grouped by app), GetDiskFreeSpaceExW,             │
│   GetProcessTimes (CPU by app), GetTickCount64 (uptime),                     │
│   InternetGetConnectedState                                                   │
│ weather: WinRT Windows.Devices.Geolocation.Geolocator → WinHTTP →            │
│   api.bigdatacloud.net (city) → api.open-meteo.com / geocoding-api           │
│ scheduler: reminders, water, bedtime, focus session, snooze                  │
│ tray-icon + muda menu · PlaySoundW (embedded WAV chime) · HKCU\…\Run         │
│ hit-testing: global cursor/raw input → hit-down/move/up/dbl events           │
│ RegisterRawInputDevices (type-along, cursor follow) · GetLastInputInfo (idle) │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ Tauri invoke / events
   ┌───────────┼─────────────────────────┬──────────────────────────┐
   ▼           ▼                         ▼                          ▼
pet.html     note.html                 settings.html            (tray menu)
transparent  chat/note popup           every knob + live
always-on-top over the cat             "what the cat sees"
overlay sized to the work area        view + notes list
pet.js (177 KB) "the desktop brain"
lib/cat.js · cat-shapes.js · cat-rig.js · cat.css (shared rig)
```

**Window model.** The pet window is transparent, borderless and always on top, and it covers the whole work area (so the cat can be dragged up and dropped with gravity). It's click-through except over the cat's hitbox (`set_hitbox`). Rust tracks the cursor and sends `hit-*` events so the cat can be dragged and double-clicked. The floor is placed so the paws sit exactly on the taskbar line (`floorY = innerHeight − 137·unit`).

## 4. The cat rig (frontend, `lib/`)

| File | Role |
|---|---|
| `cat-rig.js` | SVG markup in a `0 0 200 150` space (floor y=137). Paint order: shadow → far legs → body+tail → near legs → head group (head, inner ears, blush, eyes, glints, mouth) → props (anger mark, pawprint, hearts, Zzz). |
| `cat-shapes.js` | Geometry. Each part's pose is `[x, y, tension]` points → Catmull-Rom → cubic Bézier. **Same point count per part across poses**, so MorphSVG gets a 1:1 match. Includes a procedural 4-beat walk cycle (8 frames, "D"-shaped paw path), travelling-wave tails (`bakeWave`), and ear flick/flatten helpers. |
| `cat.js` | Controller with three layers: **POSE** (one morph per part on state change), **LOOP** (per-state idle timeline), **LIFE** (random blinks 2.4–6.5 s, ear twitches 4–11 s, props). A `generation` counter stops a superseded pose from starting its loop late. |
| `cat.css` | Colour tokens. Coats: cream / white / black (the black coat gets amber eyes). |

Public API: `Cat.init, setState, setSpeed, setFacing, getFacing, look, yawn, swipe(onImpact), groundSpeed, pawContact, getState, states, hasMorph`.
States: `walk sit peek sleep pat greet fall land angry confront bored`. Eye states: `open closed happy angry bored`. Mouths: `smile grin soft frown snarl flat oh yawn`.

`swipe()` is a timed one-shot: anticipation (paw cocks back) → strike (0.1 s, `power3.in`) → **contact frame fires `onImpact()`**, which is where the app calls `act()` to really close the tab → pawprint burst → recover into `confront`.

## 5. IPC contract (Tauri)

**Commands (`invoke`)**

| Window | Commands |
|---|---|
| pet | `get_config, greeting_name, set_hitbox, cursor, input_state, act, snooze, open_note, demo_note, promo_intro, latest_version, jslog` |
| note | `ask, add_note, size_note, close_note` |
| settings | `get_config, save_config, status, start_session, stop_session, list_notes, delete_note, memory_by_app, set_cat_visible, preview_bust, autostart_get, autostart_set, app_version, latest_version, open_link, quit_app` |

**Events (`listen`)**
pet: `bust, status, session, session-done, reminder, water, bedtime, snoozed, snooze-over, config-changed, pet-visible, preview-state, asked, note-saved, note-closed, hit-down, hit-move, hit-up, hit-dbl, latest-version` · note: `note-open, note-demo` · settings: `notes-changed, reminder-fired`

**Rust structs seen in the binary:** `Config, CatSettings, WaterSettings, SessionSettings, BedtimeSettings, Reminder, Note, Focus, Usage, Snapshot, Published, Place`.

## 6. Data model — `config.json` (defaults from the settings mock)

```json
{
  "enabled": true, "mode": "close", "countdownSeconds": 3, "snoozeMinutes": 5,
  "pollMs": 1000, "urlPollMs": 1500,
  "sites": [{ "url": "youtube.com/shorts", "minutes": 20, "enabled": true },
            { "url": "instagram.com/reel",  "minutes": 20, "enabled": true }],
  "cat": { "scale": 1, "speed": 1, "wander": true, "sleepy": true,
           "follow": false, "typeAlong": false, "greetingName": "", "coat": "cream" },
  "reminders": [{ "text": "…", "at": "YYYY-MM-DDTHH:MM", "enabled": true, "done": false }],
  "session": { "minutes": 25, "chime": true },
  "usage":   { "enabled": true, "lastPing": "", "days": 0 },
  "water":   { "enabled": true, "everyMinutes": 60 },
  "bedtime": { "enabled": true, "from": "23:00", "to": "05:00" }
}
```
Notes are `{ text, at }`, newest first. `minutes: 0` closes a site the moment it opens. Site budgets count **only while that tab is in front**.

## 7. The "ask" engine (`ask.rs`)

There's no model behind it. Each intent is a keyword set matched against the line, and each answer is a `{title, lines[]}`. The cat's speech bubble shows the title; the popup shows everything.

| Intent | Keywords (from the binary) | Source |
|---|---|---|
| memory | ram memory mem eating hog hogging | `K32EnumProcesses` + `K32GetProcessMemoryInfo`, grouped by app |
| cpu | cpu processor slow lagging laggy load busy | `GetSystemTimes` + per-process `GetProcessTimes` sampling |
| battery | battery charge charging power plugged | `GetSystemPowerStatus` |
| disk | disk disks storage space drive drives ssd | `GetDiskFreeSpaceExW` per drive |
| uptime | uptime boot booted restart restarted reboot rebooted | `GetTickCount64` |
| internet | internet online offline wifi wi network connected | `InternetGetConnectedState` |
| weather | rain raining rainy temperature forecast sunny humid humidity hot cold umbrella | Geolocator → BigDataCloud → Open-Meteo |
| site time | time long spent budget budgets | watcher usage counters |
| closed tabs | shut killed tabs | today's close log |
| notes | jot jotted wrote | notes list |

Commands: `/timer N` (aliases: pomodoro), `/snooze N` (pause, sleep, away), `/remind <text> at <time>`, `/stop`, `/wake` (unsnooze), `/hide`, `/settings`, `/quit` (exit). Unknown input gets "I do not know that one." plus suggestions.

Weather calls:
`geocoding-api.open-meteo.com/v1/search?name=…&count=1&language=en&format=json`
`api.open-meteo.com/v1/forecast?latitude=…&longitude=…&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`
`api.bigdatacloud.net/data/reverse-geocode-client?latitude=…&longitude=…&localityLanguage=en`
WMO weather codes map to plain words ("partly cloudy", "thunderstorm with hail", …).

## 8. Behaviour design worth copying (ideas, not code)

- **A warning beat:** when ≤5 s remain, the cat stops and stares (`status` event). Then it walks over in the angry gait, climbs, holds `confront` through the countdown, and swipes.
- **Interruptible sequences:** every routine is an async chain gated by an `epoch`/`generation` counter, so a drag or a snooze cancels cleanly.
- **Hidden ≠ off:** if the cat is hidden, `bustHeadless()` still enforces the budget without the animation.
- **The live view in settings** shows the exact title and URL being matched, which answers "why didn't it fire?"
- **Battery care:** loops pause off-screen, the cursor poll only runs while "follow" is on, and v3 halved idle CPU.
- **Update check:** `GET gokulbuilds.com/focuscat/version.json?v=<ver>&first=<date>&days=<n>`. It's a version check that also reports the install date and days of use (`cfg.usage`).

## 9. Rebuild plan (when we're ready to build)

**Recommended stack:** Tauri 2 + Rust, with a vanilla TS frontend and GSAP (GSAP and all its plugins, including MorphSVG, have been free since 3.13). This mirrors the original's light footprint (~2 MB installer).

| Phase | Scope |
|---|---|
| 0 | Scaffold: Tauri 2 app, three windows (overlay, popup, settings), tray, `config.json` load/save, autostart |
| 1 | **Our own character**: an original rig (different animal or design) using the same technique: point lists → Catmull-Rom → morph, plus a POSE/LOOP/LIFE controller |
| 2 | Overlay mechanics: work-area sizing, click-through hitbox, drag + gravity, floor snapping |
| 3 | Ask engine: shape classifier, intent tables, Win32 system queries, Open-Meteo weather |
| 4 | Watcher: foreground window + UIA address-bar URL, per-site budgets, Ctrl+W / InvokePattern close, countdown UX |
| 5 | Notes, reminders, focus timer, water and bedtime routines, settings UI |
| 6 | Packaging (NSIS), code signing to avoid SmartScreen friction, an Android port later |

Useful crates: `tauri 2`, `tauri-plugin-autostart`, `windows` (Win32_UI_Accessibility, Win32_System_*, Devices_Geolocation), `serde_json`, `chrono`, and `ureq` or WinHTTP for HTTP.

## 10. Legal / ethics notes

- The installer ships an **MIT License, "Copyright (c) 2026 X-DIABLO-X"**. The binary also links `github.com/X-DIABLO-X/badkat`, which may be the author's public source repo; it wasn't reachable from this session. MIT allows reuse **with the copyright notice kept**. Still, confirm the license covers the art and site code, not just the binary, before copying any file verbatim.
- Default plan: **our repo holds original code and an original character**. The extracted files stay in `research/extracted/` for reference, and that folder is git-ignored so they never get pushed.
- Don't reuse the FocusCat name or branding.
- GSAP / MorphSVG files keep their own GSAP license. Install them from npm rather than vendoring the copies taken from the app.
