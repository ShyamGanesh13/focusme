# FocusMe · DeskPal

A desktop companion for **macOS** that floats over everything — including other apps'
full-screen Spaces — on **every monitor**. Triple-tap it to chat: ask about your battery,
memory, disk, CPU or the weather. You can also start a focus timer, set reminders, or jot a
note. It wanders, naps, waves, and drops back down when you drag it into the air.

By default it runs in **peek mode**: tucked away off-screen, it slides up from the
bottom-right only when there's a nudge (a reminder, a routine, a water break, a timer),
then slides away — so it's out of your way until it has something to say. Turn that off in
Settings → Pet to keep it on screen all the time.

**Bring your own character.** Any SVG works as the pet (see
[docs/CHARACTER_SVG.md](docs/CHARACTER_SVG.md)). The bundled one, "Pip", is a placeholder.

Built with **Tauri 2** (Rust) and vanilla JS. The installer is small, there's no Electron,
and everything stays on your Mac.

## Quick start (macOS)

```bash
./scripts/setup-mac.sh     # Xcode CLT + Rust + npm install, only what's missing
./scripts/install-mac.sh   # build + install to ~/Applications + launch (the everyday way)
```

`install-mac.sh` builds FocusMe, installs it to `~/Applications`, and launches it as a
background menu-bar app — **you can then close the terminal and it keeps running**, and it
relaunches at login. Re-run the script any time to update the installed app to your latest
code. (First launch of an unsigned build may need a right-click → Open; see Development.)

For hacking on it, use the dev server instead, which rebuilds on save but must stay in the
foreground:

```bash
npm run dev                # launch FocusMe in development (keep this terminal open)
```

Its menu-bar icon has Talk, Focus, Show/Hide, Settings and Quit.

| Do this | It does |
|---|---|
| Click it | A hop and a 😎 |
| Double-click it | Says hello and wishes you a good day |
| Triple-click it | Opens the chat box |
| Drag it | Picks it up; let go and it falls back down |
| Right-click it | Opens a quick menu |

## The chat box

What you type is handled by its shape (no AI model; it's instant and works offline):

| You type | It does |
|---|---|
| `something?` | **asks**: `battery?` `memory?` `cpu?` `disk?` `uptime?` `internet?` `weather?` `weather in Chennai?` `timer?` `notes?` `reminders?` `time?` |
| `/command` | **runs** (see below) |
| anything else | **saves a note** (Settings → Notes) |

Commands:

| Command | What it does |
|---|---|
| `/timer 25`, `/stop` | Start / stop a focus session (countdown badge; starting a second one won't clobber a running one) |
| `/remind call Kavi at 5pm` | A **one-off** reminder in natural phrasing (`in 20 min`, `tomorrow 9am`) |
| `/daily 11:30 chia seeds` | A reminder at the **same time every day** (`3:30pm`, `9am` all work) |
| `/every 2h stand and stretch` | A repeating **routine** on an interval (`90m`, `120`) |
| `/water 30`, `/water off` | A drink-water nudge every N minutes |
| `/note buy milk` | Save a note |
| `/sleep` `/hide` `/settings` `/quit` `/help` | Nap, hide, open Settings, quit, show this list |

Every nudge appears as a speech bubble with quick buttons (Done / Snooze / Stop), and also
a native macOS notification for water, one-off and daily reminders, and session end.

## Features

- A transparent, click-through overlay that floats over other apps **and their full-screen Spaces**, on **every monitor** — one pet per display, created/removed live as you plug or unplug screens. Only the pet catches the mouse; everything else passes through to your apps.
- **Peek mode** (default): hidden until a nudge, then slides up from the bottom-right and away again. Stays on screen through a focus session so the timer is visible.
- Idle life (when not in peek mode): breathing, blinking, strolling the bottom-right, head tilts, waves, dozing after 5 minutes alone, eyes that follow the pointer.
- Focus sessions with a countdown badge, pause/resume, and a chime at the end.
- Three kinds of reminder: **one-off** natural phrasing ("tomorrow 9am standup"), **daily** at a set clock time, and interval **routines** — each with Snooze/Stop buttons.
- Water nudges and bedtime (says goodnight and sleeps; pauses water and routines overnight).
- Open at login (LaunchAgent), on by default.
- Weather from [Open-Meteo](https://open-meteo.com), free with no key. Your city is set in Settings.

## Project layout

```
src/                     frontend (served as-is, no bundler)
  pet.html|css|js        the overlay: behaviour, chat box, speech bubble
  settings.html|css|js   settings window
  lib/character.js       drop-in SVG engine (sanitising + part animation)
  lib/bridge.js          Tauri bridge + in-browser mock for `npm run preview`
  characters/default.svg placeholder character
src-tauri/src/
  main.rs                app wiring
  overlay.rs             one overlay window per monitor, click-through hit-testing, tray, settings window
  ask.rs                 chat classifier + intents + commands
  when.rs                reminder time parsing
  sys.rs                 battery / memory / cpu / disk / uptime / internet
  weather.rs             Open-Meteo
  scheduler.rs           1-second heartbeat: sessions, one-off + daily reminders, routines, water, bedtime
  state.rs               config.json + notes.json
docs/                    character guide, research
```

Data lives in `~/Library/Application Support/com.shyamganesh.deskpal/` as `config.json`,
`notes.json` and `character.svg`.

## Development

```bash
npm run preview                        # UI in a browser with a mock backend
cd src-tauri && cargo test             # 17 unit tests (parser, intents, scheduler)
npm run build                          # .app + .dmg in src-tauri/target/release/bundle
./scripts/install-mac.sh               # build + install to ~/Applications + relaunch
```

The unsigned build may be blocked on first launch. To open it, right-click FocusMe.app →
Open, or run `xattr -dr com.apple.quarantine FocusMe.app`. Transparent windows use Tauri's
`macOSPrivateApi`, which is fine for direct distribution but not for the Mac App Store.

## Background

`docs/research/ANALYSIS.md` is the reverse-engineering teardown of FocusCat (a Windows
Tauri app) that inspired this project. The code and character here are original.

## Roadmap

- [x] Your own logo/character SVG (drop-in)
- [x] Multiple monitors (one pet per display, live as you plug/unplug)
- [x] Daily reminders and repeating routines
- [x] Peek mode (hide until there's a nudge)
- [ ] Close distracting browser tabs on a daily budget (Chrome / Safari / Arc via AppleScript)
- [ ] Auto-update the installed app (so changes don't need a re-run of `install-mac.sh`)
- [ ] Signed and notarised releases
- [ ] Windows build (the Rust side is already cross-platform)
