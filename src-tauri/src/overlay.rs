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

/// Keep the overlay above the app you're actually using.
///
/// Tauri's `always_on_top` only lifts the window to the floating level, and a
/// no-dock (accessory) app's floating window still gets ordered behind the
/// frontmost application. So on macOS we raise the native NSWindow to the
/// status-item level and set a collection behavior that puts it on every
/// Space and alongside full-screen apps, which is the standard recipe for a
/// desktop pet that has to sit on top of everything.
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
pub fn pin_above_everything(app: &AppHandle) {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};
    // libobjc; lets us re-class the live NSWindow into an NSPanel.
    extern "C" {
        fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
    }

    let Some(win) = app.get_webview_window("pet") else { return };
    let Ok(ptr) = win.ns_window() else { return };
    let ns = ptr as *mut Object;
    if ns.is_null() {
        return;
    }

    // Sit above another app's full-screen window. NSStatusWindowLevel (25) is
    // enough over ordinary windows but not reliably over a full-screen Space;
    // NSScreenSaverWindowLevel (1000) is. The overlay only spans the work area
    // (below the menu bar) and the pet sits bottom-right, so a high level never
    // actually paints over the menu bar or notifications.
    const OVERLAY_LEVEL: isize = 1000;
    // canJoinAllSpaces (1<<0) | fullScreenAuxiliary (1<<8): show on every Space,
    // INCLUDING another app's full-screen Space. `stationary` (1<<4) is
    // deliberately NOT set — it pins the window to the desktop Space and keeps
    // it from joining full-screen Spaces, which was the bug.
    const BEHAVIOR: usize = (1 << 0) | (1 << 8);
    const NONACTIVATING_PANEL: usize = 1 << 7; // NSWindowStyleMaskNonactivatingPanel

    unsafe {
        // Turn the window into a non-activating NSPanel once. A plain NSWindow,
        // however high its level, is still confined to its own Space; a
        // non-activating panel with the behavior below is the one kind of
        // window macOS lets hover over other apps' full-screen Spaces, and it
        // does so without stealing focus from the app underneath.
        if let Some(panel) = Class::get("NSPanel") {
            let pcls: *const Class = panel;
            let is_panel: bool = msg_send![ns, isKindOfClass: pcls];
            if !is_panel {
                object_setClass(ns, pcls);
                let mask: usize = msg_send![ns, styleMask];
                let _: () = msg_send![ns, setStyleMask: mask | NONACTIVATING_PANEL];
                let _: () = msg_send![ns, setFloatingPanel: true];
                let _: () = msg_send![ns, setBecomesKeyOnlyIfNeeded: true];
            }
        }
        let _: () = msg_send![ns, setLevel: OVERLAY_LEVEL];
        let _: () = msg_send![ns, setCollectionBehavior: BEHAVIOR];
        let _: () = msg_send![ns, orderFrontRegardless];

        // One-time readback so a still-broken setup is diagnosable from the log.
        use std::sync::atomic::{AtomicBool, Ordering};
        static LOGGED: AtomicBool = AtomicBool::new(false);
        if !LOGGED.swap(true, Ordering::Relaxed) {
            let lvl: isize = msg_send![ns, level];
            let beh: usize = msg_send![ns, collectionBehavior];
            let is_panel: bool = Class::get("NSPanel")
                .map(|p| { let pc: *const Class = p; msg_send![ns, isKindOfClass: pc] })
                .unwrap_or(false);
            eprintln!("[focusme/overlay] applied level={lvl} behavior={beh} panel={is_panel}");
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn pin_above_everything(_app: &AppHandle) {}

/// Give the pet window real keyboard focus so the chat box can be typed into.
///
/// The overlay is a *non-activating* accessory panel: clicking it never makes
/// our app active, which is what keeps it hovering over other apps without
/// stealing focus — but it also means a plain `makeKeyWindow` from the
/// background won't deliver keystrokes. When the user actually opens the chat
/// we briefly activate the app and make the panel key, so the text field
/// receives input. It stays on the current Space (canJoinAllSpaces), so this
/// doesn't yank you out of a full-screen app.
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
pub fn focus_for_input(app: &AppHandle) {
    use objc::runtime::{Class, Object};
    use objc::{msg_send, sel, sel_impl};

    let Some(win) = app.get_webview_window("pet") else { return };
    let Ok(ptr) = win.ns_window() else { return };
    let ns = ptr as *mut Object;
    if ns.is_null() {
        return;
    }
    unsafe {
        if let Some(appcls) = Class::get("NSApplication") {
            let nsapp: *mut Object = msg_send![appcls, sharedApplication];
            let _: () = msg_send![nsapp, activateIgnoringOtherApps: true];
        }
        let nil: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![ns, makeKeyAndOrderFront: nil];
    }
}

#[cfg(not(target_os = "macos"))]
pub fn focus_for_input(_app: &AppHandle) {}

pub fn setup(app: &App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    fit_to_work_area(&handle);
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_ignore_cursor_events(true);
        win.show()?;
        // The window level has to sit above ordinary windows or a maximized
        // app paints over the overlay; alwaysOnTop is set in config but we
        // reassert it here after show for good measure.
        let _ = win.set_always_on_top(true);
        // Devtools are opened only when DESKPAL_DEVTOOLS=1 — never automatically.
        #[cfg(debug_assertions)]
        if std::env::var("DESKPAL_DEVTOOLS").is_ok() {
            win.open_devtools();
        }
    }
    pin_above_everything(&handle);
    // The monitor's work area can read as empty for the first instant after
    // launch, which would leave the window at its default 900x600. Re-fit and
    // re-pin a couple of times shortly after show. The native level/collection
    // calls touch AppKit, which is main-thread only, so the work is dispatched
    // back onto the main thread rather than run on this timer thread.
    {
        let h = handle.clone();
        std::thread::spawn(move || {
            let mut i = 0u32;
            loop {
                // Fit a few times early (monitor size can read empty at first),
                // then re-assert the window level forever every 2s — some apps
                // reset other apps' always-on-top level when they activate, and
                // this heals it so the pet keeps floating above them.
                std::thread::sleep(Duration::from_millis(if i < 3 { 250 } else { 2000 }));
                let first = i < 3;
                i = i.saturating_add(1);
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if first {
                        fit_to_work_area(&h2);
                    }
                    pin_above_everything(&h2);
                });
            }
        });
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
        .title("FocusMe Settings")
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
    let chat = MenuItem::with_id(app, "chat", "Talk to FocusMe", true, None::<&str>)?;
    let focus = MenuItem::with_id(app, "focus", "Start focus session", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Show / hide pet", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit FocusMe", true, Some("CmdOrCtrl+Q"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&chat, &focus, &sep, &toggle, &settings, &sep2, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("FocusMe")
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
