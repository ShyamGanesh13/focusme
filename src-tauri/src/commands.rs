//! Everything the two webviews can call.

use crate::ask::{self, Answer, Command, Intent, Shape};
use crate::state::{next_id, stamp, AppState, Config, Note, Rect, Reminder, Routine};
use crate::{overlay, sys, weather, when};
use chrono::{Duration, Local};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

const MAX_SVG_BYTES: usize = 2 * 1024 * 1024;
const MAX_NOTE_CHARS: usize = 4000;

#[tauri::command]
pub fn get_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_config(app: AppHandle, state: State<AppState>, cfg: Config) {
    let mut cfg = cfg;
    for r in cfg.reminders.iter_mut() {
        if r.id == 0 {
            r.id = next_id();
        }
    }
    for r in cfg.routines.iter_mut() {
        if r.id == 0 {
            r.id = next_id();
        }
    }
    state.save_config(&cfg);
    *state.config.lock().unwrap() = cfg.clone();
    let _ = app.emit("config-changed", cfg);
}

#[tauri::command]
pub fn set_hitbox(state: State<AppState>, rects: Vec<Rect>, hold: bool) {
    let mut h = state.hit.lock().unwrap();
    h.rects = rects;
    h.hold = hold;
}

/// Give the overlay keyboard focus so the chat box can be typed into.
#[tauri::command]
pub fn focus_pet(app: AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn list_notes(state: State<AppState>) -> Vec<Note> {
    let mut n = state.notes.lock().unwrap().clone();
    n.reverse();
    n
}

fn push_note(app: &AppHandle, state: &AppState, text: &str) -> usize {
    let text: String = text.trim().chars().take(MAX_NOTE_CHARS).collect();
    let count = {
        let mut notes = state.notes.lock().unwrap();
        notes.push(Note { id: next_id(), text, at: stamp(Local::now()) });
        state.save_notes(&notes);
        notes.len()
    };
    let _ = app.emit("notes-changed", ());
    count
}

#[tauri::command]
pub fn add_note(app: AppHandle, state: State<AppState>, text: String) -> Vec<Note> {
    if !text.trim().is_empty() {
        push_note(&app, &state, &text);
    }
    list_notes(state)
}

#[tauri::command]
pub fn delete_note(app: AppHandle, state: State<AppState>, id: u64) -> Vec<Note> {
    {
        let mut notes = state.notes.lock().unwrap();
        notes.retain(|n| n.id != id);
        state.save_notes(&notes);
    }
    let _ = app.emit("notes-changed", ());
    list_notes(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub session_left: Option<i64>,
    pub session_total: Option<i64>,
}

pub fn status_of(state: &AppState) -> Status {
    let rt = state.rt.lock().unwrap();
    Status {
        session_left: rt.session_end.map(|e| (e - Local::now()).num_seconds().max(0)),
        session_total: rt.session_end.map(|_| rt.session_minutes as i64 * 60),
    }
}

#[tauri::command]
pub fn status(state: State<AppState>) -> Status {
    status_of(&state)
}

pub fn begin_session(app: &AppHandle, state: &AppState, minutes: u32) {
    let minutes = minutes.clamp(1, 600);
    {
        let mut rt = state.rt.lock().unwrap();
        rt.session_end = Some(Local::now() + Duration::minutes(minutes as i64));
        rt.session_minutes = minutes;
        rt.session_paused = None;
    }
    let _ = app.emit("session-started", minutes);
}

#[tauri::command]
pub fn pause_session(app: AppHandle, state: State<AppState>) {
    {
        let mut rt = state.rt.lock().unwrap();
        if let Some(end) = rt.session_end.take() {
            rt.session_paused = Some((end - Local::now()).num_seconds().max(0));
        }
    }
    let _ = app.emit("session-paused", ());
}

#[tauri::command]
pub fn resume_session(app: AppHandle, state: State<AppState>) {
    {
        let mut rt = state.rt.lock().unwrap();
        if let Some(rem) = rt.session_paused.take() {
            rt.session_end = Some(Local::now() + Duration::seconds(rem.max(1)));
        }
    }
    let _ = app.emit("session-resumed", ());
}

/// Push the next water nudge out by `minutes` from now.
#[tauri::command]
pub fn snooze_water(state: State<AppState>, minutes: i64) {
    let every = state.config.lock().unwrap().water.every_minutes as i64;
    let target = every * 60;
    // next fire = now + minutes  ⇒  last_water = now + minutes*60 - target
    state.rt.lock().unwrap().last_water = Local::now() + Duration::seconds(minutes * 60 - target);
}

/// Push one routine's next nudge out by `minutes` from now.
#[tauri::command]
pub fn snooze_routine(state: State<AppState>, id: u64, minutes: i64) {
    let target = state
        .config
        .lock()
        .unwrap()
        .routines
        .iter()
        .find(|r| r.id == id)
        .map(|r| r.every_minutes as i64 * 60)
        .unwrap_or(0);
    state
        .rt
        .lock()
        .unwrap()
        .routine_last
        .insert(id, Local::now() + Duration::seconds(minutes * 60 - target));
}

/// Turn one routine on or off (used by the "Stop" button on its nudge).
#[tauri::command]
pub fn set_routine_enabled(app: AppHandle, state: State<AppState>, id: u64, enabled: bool) {
    let cfg = {
        let mut cfg = state.config.lock().unwrap();
        if let Some(r) = cfg.routines.iter_mut().find(|r| r.id == id) {
            r.enabled = enabled;
        }
        state.save_config(&cfg);
        cfg.clone()
    };
    let _ = app.emit("config-changed", cfg);
}

#[tauri::command]
pub fn start_session(app: AppHandle, state: State<AppState>, minutes: Option<u32>) {
    let m = minutes.unwrap_or_else(|| state.config.lock().unwrap().session.minutes);
    begin_session(&app, &state, m);
}

#[tauri::command]
pub fn stop_session(app: AppHandle, state: State<AppState>) {
    {
        let mut rt = state.rt.lock().unwrap();
        rt.session_end = None;
        rt.session_paused = None;
    }
    let _ = app.emit("session-stopped", ());
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    overlay::open_settings(&app);
}

#[tauri::command]
pub fn set_pet_visible(app: AppHandle, visible: bool) {
    overlay::set_pet_visible(&app, visible);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    Ok(al.is_enabled().unwrap_or(enabled))
}

// ---------------------------------------------------------------- character

#[tauri::command]
pub fn get_character(state: State<AppState>) -> Option<String> {
    std::fs::read_to_string(state.character_path()).ok()
}

#[tauri::command]
pub fn set_character(app: AppHandle, state: State<AppState>, svg: String) -> Result<(), String> {
    if svg.len() > MAX_SVG_BYTES {
        return Err("That SVG is over 2 MB — please simplify it.".into());
    }
    if !svg.contains("<svg") {
        return Err("That file doesn't look like an SVG.".into());
    }
    std::fs::write(state.character_path(), &svg).map_err(|e| e.to_string())?;
    let _ = app.emit("character-changed", ());
    Ok(())
}

#[tauri::command]
pub fn reset_character(app: AppHandle, state: State<AppState>) {
    let _ = std::fs::remove_file(state.character_path());
    let _ = app.emit("character-changed", ());
}

// ---------------------------------------------------------------- the chat box

#[tauri::command]
pub async fn ask(app: AppHandle, text: String) -> Answer {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || answer(&handle, &text))
        .await
        .unwrap_or_else(|_| Answer::error("Something went wrong there.", vec![]))
}

fn answer(app: &AppHandle, text: &str) -> Answer {
    let state = app.state::<AppState>();
    let text = text.trim();
    if text.is_empty() {
        return Answer::error("Type something first.", vec![]);
    }
    match ask::classify(text) {
        Shape::Note => {
            let n = push_note(app, &state, text);
            Answer::note(&format!("Noted. That's {n} note{}.", if n == 1 { "" } else { "s" }))
        }
        Shape::Command => run_command(app, &state, ask::command(text)),
        Shape::Question => answer_question(&state, text),
    }
}

fn run_command(app: &AppHandle, state: &AppState, cmd: Command) -> Answer {
    match cmd {
        Command::Timer(m) => {
            let minutes = m.unwrap_or_else(|| state.config.lock().unwrap().session.minutes);
            begin_session(app, state, minutes);
            Answer::command(&format!("Focus session started — {minutes} min. You've got this.")).with_action("session")
        }
        Command::Stop => {
            let was = state.rt.lock().unwrap().session_end.take().is_some();
            let _ = app.emit("session-stopped", ());
            Answer::command(if was { "Focus session stopped." } else { "No focus session was running." })
        }
        Command::Water { on, minutes } => {
            let every = {
                let mut cfg = state.config.lock().unwrap();
                cfg.water.enabled = on;
                if let Some(m) = minutes {
                    cfg.water.every_minutes = m;
                }
                state.save_config(&cfg);
                cfg.water.every_minutes
            };
            eprintln!("[focusme/water] command: on={on} minutes={minutes:?} -> every {every} min");
            // Count the interval from now, so the first nudge isn't immediate.
            state.rt.lock().unwrap().last_water = Local::now();
            let _ = app.emit("config-changed", state.config.lock().unwrap().clone());
            if on {
                Answer::command(&format!("I'll remind you to drink water every {every} min. (/water off to stop.)"))
            } else {
                Answer::command("Water reminders off.")
            }
        }
        Command::Every { minutes, text } => add_routine(app, state, minutes, &text),
        Command::Remind(rest) => remind(app, state, &rest),
        Command::Note(rest) => {
            if rest.is_empty() {
                return Answer::error("Tell me what to note, like: /note buy milk", vec![]);
            }
            let n = push_note(app, state, &rest);
            Answer::note(&format!("Noted. That's {n} note{}.", if n == 1 { "" } else { "s" }))
        }
        Command::Hide => Answer::command("Hiding. Click the menu-bar icon to bring me back.").with_action("hide"),
        Command::Settings => {
            overlay::open_settings(app);
            Answer::command("Opening settings.")
        }
        Command::Quit => Answer::command("Bye! See you soon.").with_action("quit"),
        Command::Sleep => Answer::command("Nap time…").with_action("sleep"),
        Command::Help => ask::help(),
        Command::Unknown(c) => Answer::error(&format!("I don't know /{c}."), vec!["Try /help".into()]),
    }
}

fn remind(app: &AppHandle, state: &AppState, rest: &str) -> Answer {
    let now = Local::now();
    match when::parse_reminder(rest, now.naive_local()) {
        Ok((what, at)) => {
            let at_s = at.format("%Y-%m-%dT%H:%M").to_string();
            let cfg = {
                let mut cfg = state.config.lock().unwrap();
                cfg.reminders.push(Reminder { id: next_id(), text: what.clone(), at: at_s, done: false });
                state.save_config(&cfg);
                cfg.clone()
            };
            let _ = app.emit("config-changed", cfg);
            let day = if at.date() == now.date_naive() { "today".to_string() } else if at.date() == now.date_naive() + Duration::days(1) { "tomorrow".to_string() } else { at.format("%a %d %b").to_string() };
            Answer::command(&format!("I'll remind you {day} at {}: {what}", at.format("%-I:%M %p")))
        }
        Err(when::WhenError::NoTime) => Answer::error("When should I remind you?", vec!["Like: /remind call Kavi at 5pm  ·  /remind stretch in 20 min".into()]),
        Err(when::WhenError::NoText) => Answer::error("What should I remind you about?", vec!["Like: /remind call Kavi at 5pm".into()]),
    }
}

/// Human interval, e.g. 120 -> "2 h", 90 -> "1 h 30 min", 20 -> "20 min".
fn human_every(mins: u32) -> String {
    let (h, m) = (mins / 60, mins % 60);
    match (h, m) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

fn add_routine(app: &AppHandle, state: &AppState, minutes: u32, text: &str) -> Answer {
    let text = text.trim();
    if minutes == 0 {
        return Answer::error("How often should I nudge you?", vec!["Like: /every 2h stand and stretch".into()]);
    }
    if text.is_empty() {
        return Answer::error("What's the routine?", vec!["Like: /every 120 stand and stretch".into()]);
    }
    let id = next_id();
    let cfg = {
        let mut cfg = state.config.lock().unwrap();
        cfg.routines.push(Routine {
            id,
            label: text.to_string(),
            every_minutes: minutes,
            enabled: true,
            from: String::new(),
            to: String::new(),
        });
        state.save_config(&cfg);
        cfg.clone()
    };
    // Start the clock now, so the first nudge is one full interval away.
    state.rt.lock().unwrap().routine_last.insert(id, Local::now());
    let _ = app.emit("config-changed", cfg);
    Answer::command(&format!("Done — every {}, I'll nudge you: {text}", human_every(minutes)))
}

fn answer_question(state: &AppState, q: &str) -> Answer {
    match ask::intent(q) {
        Intent::Greeting => {
            let name = state.config.lock().unwrap().pet.user_name.clone();
            let hi = if name.trim().is_empty() { "Hi there!".to_string() } else { format!("Hi {}!", name.trim()) };
            Answer::answer(&hi, vec!["Ask me something, or tell me what to do. Type help for the list.".into()]).with_action("wave")
        }
        Intent::Help => ask::help(),
        Intent::Battery => sys::battery(),
        Intent::Memory => sys::memory(),
        Intent::Cpu => sys::cpu(),
        Intent::Disk => sys::disk(),
        Intent::Uptime => sys::uptime(),
        Intent::Internet => sys::internet(),
        Intent::Weather(place) => {
            let city = place.unwrap_or_else(|| state.config.lock().unwrap().weather.city.clone());
            weather::weather(&city)
        }
        Intent::Timer => match status_of(state).session_left {
            Some(left) => Answer::answer(&format!("Focus session: {}:{:02} left", left / 60, left % 60), vec![]),
            None => Answer::answer("No focus session running.", vec!["Start one with /timer 25".into()]),
        },
        Intent::Notes => {
            let notes = state.notes.lock().unwrap();
            match notes.last() {
                None => Answer::answer("No notes yet. Type one here and press Enter.", vec![]),
                Some(last) => Answer::answer(
                    &format!("{} note{}", notes.len(), if notes.len() == 1 { "" } else { "s" }),
                    vec![format!("Latest: {}", last.text.lines().next().unwrap_or("")), "All of them are in Settings → Notes.".into()],
                ),
            }
        }
        Intent::Reminders => {
            let cfg = state.config.lock().unwrap();
            let mut up: Vec<&Reminder> = cfg.reminders.iter().filter(|r| !r.done).collect();
            up.sort_by(|a, b| a.at.cmp(&b.at));
            let routines: Vec<&Routine> = cfg.routines.iter().filter(|r| r.enabled).collect();
            let mut lines: Vec<String> =
                up.iter().take(5).map(|r| format!("{} — {}", r.at.replace('T', " "), r.text)).collect();
            for r in &routines {
                lines.push(format!("every {} — {}", human_every(r.every_minutes), r.label));
            }
            if lines.is_empty() {
                Answer::answer(
                    "Nothing scheduled.",
                    vec!["/remind stretch in 30 min  ·  /every 2h stand and stretch".into()],
                )
            } else {
                let n = up.len() + routines.len();
                Answer::answer(&format!("{n} coming up"), lines)
            }
        }
        Intent::Clock => {
            let now = Local::now();
            Answer::answer(&format!("It's {}", now.format("%-I:%M %p")), vec![now.format("%A, %-d %B %Y").to_string()])
        }
        Intent::Name => Answer::answer("I'm DeskPal, your desk buddy.", vec![]),
        Intent::Unknown => Answer::error(
            "I don't know that one yet.",
            vec!["Try: battery? memory? weather? disk? timer?".into(), "Or type help for everything.".into()],
        ),
    }
}
