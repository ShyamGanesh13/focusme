//! Persistent settings, notes, and the in-memory runtime state.
//!
//! Everything the user owns lives in two small JSON files inside the app's
//! config directory (`~/Library/Application Support/com.shyamganesh.deskpal`
//! on macOS). Writes go to a temp file first and are renamed into place so a
//! crash mid-write can never leave a half-written config behind.

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PetCfg {
    /// What the pet calls you when you say hi.
    pub user_name: String,
    /// Display size multiplier (1.0 = 140 px tall).
    pub scale: f64,
    /// Animation / walking speed multiplier.
    pub speed: f64,
    /// Wander along the Dock when idle.
    pub wander: bool,
    /// Doze off when left alone for a while.
    pub sleepy: bool,
    /// Eyes follow the mouse pointer (needs a `pupils` part in the SVG).
    pub follow: bool,
    /// Peek mode: stay hidden off-screen and only slide up for a nudge
    /// (reminder, routine, water, timer end), then slide away.
    #[serde(default = "default_true")]
    pub peek: bool,
}

impl Default for PetCfg {
    fn default() -> Self {
        Self { user_name: String::new(), scale: 1.0, speed: 1.0, wander: true, sleepy: true, follow: true, peek: true }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionCfg {
    pub minutes: u32,
    pub chime: bool,
}
impl Default for SessionCfg {
    fn default() -> Self { Self { minutes: 25, chime: true } }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WaterCfg {
    pub enabled: bool,
    pub every_minutes: u32,
}
impl Default for WaterCfg {
    fn default() -> Self { Self { enabled: false, every_minutes: 60 } }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct BedtimeCfg {
    pub enabled: bool,
    /// "HH:MM", local time.
    pub from: String,
    pub to: String,
}
impl Default for BedtimeCfg {
    fn default() -> Self { Self { enabled: false, from: "23:00".into(), to: "06:00".into() } }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WeatherCfg {
    /// Home city for "weather?" — geocoded with Open-Meteo on demand.
    pub city: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    #[serde(default)]
    pub id: u64,
    pub text: String,
    /// "YYYY-MM-DDTHH:MM", local time (the format of <input type=datetime-local>).
    pub at: String,
    #[serde(default)]
    pub done: bool,
}

fn default_true() -> bool {
    true
}

/// A repeating nudge: "stand and stretch", every N minutes, optionally only
/// inside an active window. The one-off cousin is [`Reminder`].
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    #[serde(default)]
    pub id: u64,
    /// What the notification says.
    pub label: String,
    /// How often, in minutes.
    pub every_minutes: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Optional active window ("HH:MM"); both empty = all day.
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub to: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub pet: PetCfg,
    pub session: SessionCfg,
    pub water: WaterCfg,
    pub bedtime: BedtimeCfg,
    pub weather: WeatherCfg,
    pub reminders: Vec<Reminder>,
    pub routines: Vec<Routine>,
    /// Launch FocusMe automatically when you log in. On by default; the OS
    /// login item is kept in sync with this on every startup.
    #[serde(default = "default_true")]
    pub login_item: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pet: PetCfg::default(),
            session: SessionCfg::default(),
            water: WaterCfg::default(),
            bedtime: BedtimeCfg::default(),
            weather: WeatherCfg::default(),
            reminders: Vec::new(),
            routines: Vec::new(),
            login_item: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: u64,
    pub text: String,
    /// "YYYY-MM-DDTHH:MM"
    pub at: String,
}

/// A rectangle in the pet window's own CSS-pixel coordinates.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
impl Rect {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

/// Which parts of the transparent overlay should catch the mouse.
#[derive(Default)]
pub struct HitState {
    pub rects: Vec<Rect>,
    /// While true the whole window catches the mouse (dragging, chat open).
    pub hold: bool,
}

pub struct Runtime {
    pub session_end: Option<DateTime<Local>>,
    pub session_minutes: u32,
    /// Seconds remaining while a focus session is paused.
    pub session_paused: Option<i64>,
    pub last_water: DateTime<Local>,
    pub bedtime_fired: Option<String>,
    /// When each routine last fired, keyed by routine id. A routine starts
    /// counting from the moment it's first seen, so it never fires instantly.
    pub routine_last: std::collections::HashMap<u64, DateTime<Local>>,
}

pub struct AppState {
    pub dir: PathBuf,
    pub config: Mutex<Config>,
    pub notes: Mutex<Vec<Note>>,
    pub rt: Mutex<Runtime>,
    /// Hit rectangles per overlay window (one window per monitor), keyed by
    /// the window's label, so each screen's pet catches the mouse independently.
    pub hit: Mutex<std::collections::HashMap<String, HitState>>,
    /// Whether the pet is shown (the Hide/Show toggle), honored across monitors
    /// and across the periodic monitor reconcile.
    pub visible: std::sync::atomic::AtomicBool,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// Unique, roughly time-ordered ids without pulling in a uuid crate.
pub fn next_id() -> u64 {
    let now = Local::now().timestamp_millis() as u64;
    let mut prev = NEXT_ID.load(Ordering::Relaxed);
    loop {
        let candidate = now.max(prev + 1);
        match NEXT_ID.compare_exchange(prev, candidate, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return candidate,
            Err(p) => prev = p,
        }
    }
}

pub fn stamp(t: DateTime<Local>) -> String {
    t.format("%Y-%m-%dT%H:%M").to_string()
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("[deskpal] {} unreadable ({e}); using defaults", path.display());
            T::default()
        }),
        Err(_) => T::default(),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    let tmp = path.with_extension("json.tmp");
    let result = serde_json::to_string_pretty(value)
        .map_err(|e| e.to_string())
        .and_then(|s| fs::write(&tmp, s).map_err(|e| e.to_string()))
        .and_then(|_| fs::rename(&tmp, path).map_err(|e| e.to_string()));
    if let Err(e) = result {
        eprintln!("[deskpal] could not save {}: {e}", path.display());
    }
}

impl AppState {
    pub fn load(dir: PathBuf) -> Self {
        let mut config: Config = read_json(&dir.join("config.json"));
        for r in config.reminders.iter_mut() {
            if r.id == 0 {
                r.id = next_id();
            }
        }
        for r in config.routines.iter_mut() {
            if r.id == 0 {
                r.id = next_id();
            }
        }
        let notes: Vec<Note> = read_json(&dir.join("notes.json"));
        Self {
            dir,
            config: Mutex::new(config),
            notes: Mutex::new(notes),
            rt: Mutex::new(Runtime {
                session_end: None,
                session_minutes: 0,
                session_paused: None,
                last_water: Local::now(),
                bedtime_fired: None,
                routine_last: std::collections::HashMap::new(),
            }),
            hit: Mutex::new(std::collections::HashMap::new()),
            visible: std::sync::atomic::AtomicBool::new(true),
        }
    }

    pub fn save_config(&self, cfg: &Config) {
        write_json(&self.dir.join("config.json"), cfg);
    }

    pub fn save_notes(&self, notes: &[Note]) {
        write_json(&self.dir.join("notes.json"), &notes.to_vec());
    }

    pub fn character_path(&self) -> PathBuf {
        self.dir.join("character.svg")
    }
}
