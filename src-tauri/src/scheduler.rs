//! A one-second heartbeat: focus sessions, reminders, water, bedtime.
//! Rust owns the clock so timers keep running while the pet is hidden.

use crate::state::AppState;
use chrono::{Duration, Local, NaiveDateTime, NaiveTime, Timelike};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Tick {
    session_left: Option<i64>,
    session_total: Option<i64>,
    session_paused: bool,
    bedtime: bool,
}

fn hm(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

/// True when `t` is inside [from, to), handling windows that cross midnight.
pub fn in_window(from: &str, to: &str, t: NaiveTime) -> bool {
    match (hm(from), hm(to)) {
        (Some(f), Some(e)) if f < e => t >= f && t < e,
        (Some(f), Some(e)) if f > e => t >= f || t < e,
        _ => false,
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        {
            let state = app.state::<AppState>();
            let c = state.config.lock().unwrap();
            eprintln!(
                "[focusme/sched] started — water enabled={} every={}min, bedtime={}, reminders={}, routines={}",
                c.water.enabled,
                c.water.every_minutes,
                c.bedtime.enabled,
                c.reminders.iter().filter(|r| !r.done).count(),
                c.routines.iter().filter(|r| r.enabled).count()
            );
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            beat(&app);
        }
    });
}

/// A real system notification (shows in Notification Center, plays a sound),
/// so a reminder reaches you even when the pet is hidden, behind a window, or
/// the chat is open. osascript is always present on macOS and needs no signing.
#[cfg(target_os = "macos")]
fn notify(title: &str, body: &str) {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ");
    let script = format!(
        "display notification \"{}\" with title \"{}\" sound name \"Glass\"",
        esc(body),
        esc(title)
    );
    let _ = std::process::Command::new("osascript").arg("-e").arg(script).spawn();
}
#[cfg(not(target_os = "macos"))]
fn notify(_title: &str, _body: &str) {}

fn beat(app: &AppHandle) {
    let state = app.state::<AppState>();
    let now = Local::now();
    let cfg = state.config.lock().unwrap().clone();
    let t = now.time().with_second(0).unwrap_or(now.time());
    let bedtime = cfg.bedtime.enabled && in_window(&cfg.bedtime.from, &cfg.bedtime.to, t);

    // focus session
    let mut paused = false;
    let (left, total, done) = {
        let mut rt = state.rt.lock().unwrap();
        let tot = rt.session_minutes as i64 * 60;
        if let Some(rem) = rt.session_paused {
            paused = true;
            (Some(rem), Some(tot), None)
        } else {
            match rt.session_end {
                Some(end) if end <= now => {
                    rt.session_end = None;
                    (None, None, Some(rt.session_minutes))
                }
                Some(end) => (Some((end - now).num_seconds()), Some(tot), None),
                None => (None, None, None),
            }
        }
    };
    if let Some(m) = done {
        notify("Focus session done", &format!("{m} minutes up — take a short break."));
        let _ = app.emit("session-done", m);
    }
    let _ = app.emit("tick", Tick { session_left: left, session_total: total, session_paused: paused, bedtime });

    // reminders
    let mut fired = vec![];
    {
        let mut c = state.config.lock().unwrap();
        for r in c.reminders.iter_mut().filter(|r| !r.done) {
            if let Ok(at) = NaiveDateTime::parse_from_str(&r.at, "%Y-%m-%dT%H:%M") {
                if at <= now.naive_local() {
                    r.done = true;
                    fired.push(r.clone());
                }
            }
        }
        if !fired.is_empty() {
            state.save_config(&c);
            let _ = app.emit("config-changed", c.clone());
        }
    }
    for r in fired {
        eprintln!("[focusme/reminder] firing: {} ({})", r.text, r.at);
        notify("Reminder", &r.text);
        let _ = app.emit("reminder", r);
    }

    // water (paused during a focus session and bedtime)
    if cfg.water.enabled && !bedtime && left.is_none() {
        let mut rt = state.rt.lock().unwrap();
        let elapsed = (now - rt.last_water).num_seconds();
        let target = (cfg.water.every_minutes.max(1) as i64) * 60;
        if elapsed % 30 == 0 {
            eprintln!("[focusme/water] on — {elapsed}s of {target}s");
        }
        if elapsed >= target {
            rt.last_water = now;
            drop(rt);
            eprintln!("[focusme/water] firing water nudge");
            notify("FocusMe", "Time for a sip of water.");
            let _ = app.emit("water", ());
        }
    } else if cfg.water.enabled && now.timestamp() % 30 == 0 {
        let why = if left.is_some() { "focus session running" } else if bedtime { "bedtime window" } else { "?" };
        eprintln!("[focusme/water] paused ({why})");
    }

    // recurring routines — "stand & stretch every 2h". They run independently
    // of focus sessions (a stretch mid-focus is fine) but pause at bedtime.
    if !bedtime {
        let mut fired_routines = vec![];
        {
            let mut rt = state.rt.lock().unwrap();
            for r in cfg.routines.iter().filter(|r| r.enabled && r.every_minutes > 0) {
                // honour an optional active window
                if !r.from.trim().is_empty() && !r.to.trim().is_empty() && !in_window(&r.from, &r.to, t) {
                    continue;
                }
                let last = *rt.routine_last.entry(r.id).or_insert(now);
                let target = (r.every_minutes as i64) * 60;
                if (now - last).num_seconds() >= target {
                    rt.routine_last.insert(r.id, now);
                    fired_routines.push(r.clone());
                }
            }
            // forget routines that no longer exist, so ids can't leak forever
            let live: std::collections::HashSet<u64> = cfg.routines.iter().map(|r| r.id).collect();
            rt.routine_last.retain(|id, _| live.contains(id));
        }
        for r in fired_routines {
            eprintln!("[focusme/routine] firing: {} (every {}min)", r.label, r.every_minutes);
            // Bubble only — no system banner for routines (kept for water/reminders/session).
            let _ = app.emit("routine", r);
        }
    }

    // bedtime: announce once per night
    if bedtime {
        // a window that crosses midnight belongs to the evening it started on
        let night = if hm(&cfg.bedtime.from).map(|f| t < f).unwrap_or(false) { now.date_naive() - Duration::days(1) } else { now.date_naive() };
        let key = night.to_string();
        let mut rt = state.rt.lock().unwrap();
        if rt.bedtime_fired.as_deref() != Some(key.as_str()) {
            rt.bedtime_fired = Some(key);
            drop(rt);
            let _ = app.emit("bedtime", ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn windows() {
        assert!(in_window("23:00", "06:00", t(23, 30)));
        assert!(in_window("23:00", "06:00", t(2, 0)));
        assert!(!in_window("23:00", "06:00", t(12, 0)));
        assert!(in_window("13:00", "14:00", t(13, 0)));
        assert!(!in_window("13:00", "14:00", t(14, 0)));
        assert!(!in_window("bad", "06:00", t(2, 0)));
    }
}
