# FocusMe · DeskPal

A desktop companion for **macOS** that lives on top of your Dock. Double-click it to chat:
ask about your battery, memory, disk, CPU or the weather. You can also start a focus timer,
set a reminder, or jot a note. It wanders, naps, waves, and drops back down when you drag
it into the air.

**Bring your own character.** Any SVG works as the pet (see
[docs/CHARACTER_SVG.md](docs/CHARACTER_SVG.md)). The bundled one, "Pip", is a placeholder.

Built with **Tauri 2** (Rust) and vanilla JS. The installer is small, there's no Electron,
and everything stays on your Mac.

## Quick start (macOS)

```bash
./scripts/setup-mac.sh     # Xcode CLT + Rust + npm install, only what's missing
npm run dev                # launch DeskPal
```

The pet appears just above the Dock. Its menu-bar icon has Talk, Focus, Show/Hide,
Settings and Quit.

| Do this | It does |
|---|---|
| Double-click the pet | Opens the chat box |
| Click it | A happy hop |
| Drag it | Picks it up; let go and it falls back down |
| Right-click it | Opens a quick menu |

## The chat box

What you type is handled by its shape (no AI model; it's instant and works offline):

| You type | It does |
|---|---|
| `something?` | **asks**: `battery?` `memory?` `cpu?` `disk?` `uptime?` `internet?` `weather?` `weather in Chennai?` `timer?` `notes?` `reminders?` `time?` |
| `/command` | **runs**: `/timer 25` `/stop` `/remind call Kavi at 5pm` `/remind stretch in 20 min` `/sleep` `/hide` `/settings` `/quit` `/help` |
| anything else | **saves a note** (Settings → Notes) |

## Features (v1)

- A transparent, click-through overlay. Only the pet catches the mouse; everything else passes through to your apps.
- Idle life: breathing, blinking, strolling, head tilts, waves, dozing after 5 minutes alone, eyes that follow the pointer.
- Focus sessions with a countdown badge and a chime at the end.
- Reminders in natural phrasing ("tomorrow 9am standup", "in 2 hours check the oven").
- Water nudges and bedtime (says goodnight and sleeps).
- Open at login (LaunchAgent).
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
  overlay.rs             work-area window, click-through hit-testing, tray, settings window
  ask.rs                 chat classifier + intents + commands
  when.rs                reminder time parsing
  sys.rs                 battery / memory / cpu / disk / uptime / internet
  weather.rs             Open-Meteo
  scheduler.rs           1-second heartbeat: sessions, reminders, water, bedtime
  state.rs               config.json + notes.json
docs/                    character guide, research
```

Data lives in `~/Library/Application Support/com.shyamganesh.deskpal/` as `config.json`,
`notes.json` and `character.svg`.

## Development

```bash
npm run preview                        # UI in a browser with a mock backend
cd src-tauri && cargo test             # 15 unit tests (parser, intents, scheduler)
npm run build                          # .app + .dmg in src-tauri/target/release/bundle
```

The unsigned build may be blocked on first launch. To open it, right-click DeskPal.app →
Open, or run `xattr -dr com.apple.quarantine DeskPal.app`. Transparent windows use Tauri's
`macOSPrivateApi`, which is fine for direct distribution but not for the Mac App Store.

## Background

`docs/research/ANALYSIS.md` is the reverse-engineering teardown of FocusCat (a Windows
Tauri app) that inspired this project. The code and character here are original.

## Roadmap

- [ ] Your own logo/character SVG (drop-in)
- [ ] Close distracting browser tabs on a daily budget (Chrome / Safari / Arc via AppleScript)
- [ ] Multiple monitors
- [ ] Signed and notarised releases
- [ ] Windows build (the Rust side is already cross-platform)
