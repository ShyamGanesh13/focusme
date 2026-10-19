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
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        beat(&app);
    });
}

fn beat(app: &AppHandle) {
    let state = app.state::<AppState>();
    let now = Local::now();
    let cfg = state.config.lock().unwrap().clone();
    let t = now.time().with_second(0).unwrap_or(now.time());
    let bedtime = cfg.bedtime.enabled && in_window(&cfg.bedtime.from, &cfg.bedtime.to, t);

    // focus session
    let (left, total, done) = {
        let mut rt = state.rt.lock().unwrap();
        match rt.session_end {
            Some(end) if end <= now => {
                rt.session_end = None;
                (None, None, Some(rt.session_minutes))
            }
            Some(end) => (Some((end - now).num_seconds()), Some(rt.session_minutes as i64 * 60), None),
            None => (None, None, None),
        }
    };
    if let Some(m) = done {
        let _ = app.emit("session-done", m);
    }
    let _ = app.emit("tick", Tick { session_left: left, session_total: total, bedtime });

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
        let _ = app.emit("reminder", r);
    }

    // water
    if cfg.water.enabled && !bedtime && left.is_none() {
        let mut rt = state.rt.lock().unwrap();
        if now - rt.last_water >= Duration::minutes(cfg.water.every_minutes.max(5) as i64) {
            rt.last_water = now;
            drop(rt);
            let _ = app.emit("water", ());
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
