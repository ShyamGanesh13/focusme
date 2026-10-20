// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ask;
mod commands;
mod overlay;
mod scheduler;
mod state;
mod sys;
mod weather;
mod when;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            // A desk pet, not an app you switch to: no Dock icon, menu-bar only.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::load(dir));

            // Keep the OS login item in step with the setting on every launch.
            // Defaults to on, so a freshly installed FocusMe registers itself to
            // start at login; the installed app's path is what gets registered.
            {
                use tauri_plugin_autostart::ManagerExt;
                let want = app.state::<state::AppState>().config.lock().unwrap().login_item;
                let al = app.autolaunch();
                let is_on = al.is_enabled().unwrap_or(false);
                if want && !is_on {
                    let _ = al.enable();
                } else if !want && is_on {
                    let _ = al.disable();
                }
            }

            overlay::build_tray(app)?;
            overlay::setup(app)?;
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::set_hitbox,
            commands::pet_ready,
            commands::focus_pet,
            commands::ask,
            commands::list_notes,
            commands::add_note,
            commands::delete_note,
            commands::status,
            commands::start_session,
            commands::stop_session,
            commands::pause_session,
            commands::resume_session,
            commands::snooze_water,
            commands::snooze_routine,
            commands::set_routine_enabled,
            commands::open_settings,
            commands::set_pet_visible,
            commands::quit_app,
            commands::app_version,
            commands::autostart_get,
            commands::autostart_set,
            commands::get_character,
            commands::set_character,
            commands::reset_character,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FocusMe");
}
