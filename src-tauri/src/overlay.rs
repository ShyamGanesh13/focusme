//! The pet window: a transparent, always-on-top overlay the size of the
//! screen's work area (everything except the menu bar and the Dock), so the
//! pet's floor is exactly the top edge of the Dock.
//!
//! The overlay ignores the mouse everywhere except over the pet (and the chat
//! box while it is open). The webview reports those rectangles through
//! `set_hitbox`; a small thread polls the global cursor and flips
//! `set_ignore_cursor_events` whenever the pointer crosses into or out of them.

use crate::state::AppState;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Serialize, Clone, Copy)]
struct Cursor {
    x: f64,
    y: f64,
}

pub fn fit_to_work_area(app: &AppHandle) {
    let Some(win) = app.get_webview_window("pet") else { return };
    let monitor = win.primary_monitor().ok().flatten().or_else(|| win.current_monitor().ok().flatten());
    if let Some(m) = monitor {
        let wa = m.work_area();
        let _ = win.set_position(PhysicalPosition::new(wa.position.x, wa.position.y));
        let _ = win.set_size(PhysicalSize::new(wa.size.width, wa.size.height));
    }
}

pub fn setup(app: &App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    fit_to_work_area(&handle);
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_ignore_cursor_events(true);
        win.show()?;
    }
    std::thread::spawn(move || hit_loop(handle));
    Ok(())
}

fn hit_loop(app: AppHandle) {
    let mut catching: Option<bool> = None;
    let mut last_cursor = (f64::NAN, f64::NAN);
    let mut last_emit = Instant::now();
    let mut last_fit = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(25));
        let Some(win) = app.get_webview_window("pet") else { continue };
        if !win.is_visible().unwrap_or(false) {
            continue;
        }
        // The Dock can be resized or moved; re-fit every few seconds.
        if last_fit.elapsed() > Duration::from_secs(5) {
            last_fit = Instant::now();
            fit_to_work_area(&app);
        }
        let (Ok(cur), Ok(pos), Ok(scale)) = (app.cursor_position(), win.outer_position(), win.scale_factor()) else {
            continue;
        };
        // Into the window's CSS-pixel space.
        let lx = (cur.x - pos.x as f64) / scale;
        let ly = (cur.y - pos.y as f64) / scale;

        let inside = {
            let state = app.state::<AppState>();
            let h = state.hit.lock().unwrap();
            h.hold || h.rects.iter().any(|r| r.contains(lx, ly))
        };
        if catching != Some(inside) {
            catching = Some(inside);
            let _ = win.set_ignore_cursor_events(!inside);
        }

        // Feed the pointer to the pet ~20x a second (eyes follow, curiosity).
        let moved = (lx - last_cursor.0).abs() > 1.0 || (ly - last_cursor.1).abs() > 1.0;
        if moved && last_emit.elapsed() >= Duration::from_millis(50) {
            last_cursor = (lx, ly);
            last_emit = Instant::now();
            let _ = win.emit("cursor", Cursor { x: lx, y: ly });
        }
    }
}

pub fn set_pet_visible(app: &AppHandle, visible: bool) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = if visible { w.show() } else { w.hide() };
        let _ = app.emit("pet-visible", visible);
    }
}

pub fn toggle_pet(app: &AppHandle) {
    let visible = app.get_webview_window("pet").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    set_pet_visible(app, !visible);
}

pub fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("DeskPal Settings")
        .inner_size(620.0, 680.0)
        .min_inner_size(520.0, 520.0)
        .center()
        .focused(true)
        .build();
    if let Err(e) = built {
        eprintln!("[deskpal] could not open settings: {e}");
    }
}

pub fn build_tray(app: &App) -> tauri::Result<()> {
    let chat = MenuItem::with_id(app, "chat", "Talk to DeskPal", true, None::<&str>)?;
    let focus = MenuItem::with_id(app, "focus", "Start focus session", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Show / hide pet", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit DeskPal", true, Some("CmdOrCtrl+Q"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&chat, &focus, &sep, &toggle, &settings, &sep2, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("DeskPal")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "chat" => {
                set_pet_visible(app, true);
                let _ = app.emit("open-chat", ());
            }
            "focus" => {
                let state = app.state::<AppState>();
                let minutes = state.config.lock().unwrap().session.minutes;
                crate::commands::begin_session(app, &state, minutes);
            }
            "toggle" => toggle_pet(app),
            "settings" => open_settings(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
