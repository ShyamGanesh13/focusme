//! Once a day, ask GitHub Releases whether a newer FocusMe is out and, if so,
//! tell the pets (they show an "Update" bubble with a Download button).
//!
//! Reads the redirect of `/releases/latest` (→ `/releases/tag/vX.Y.Z`) rather
//! than the REST API, which is rate-limited per IP and often exhausted on
//! shared office networks.

use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const RELEASES: &str = "https://github.com/ShyamGanesh13/focusme/releases";

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60)); // let the pets load first
        let current = app.package_info().version.to_string();
        let mut told = String::new();
        loop {
            if let Some(latest) = latest_version() {
                if newer(&latest, &current) && latest != told {
                    eprintln!("[focusme/update] {latest} is out (running {current})");
                    let url = format!("{RELEASES}/tag/v{latest}");
                    let _ = app.emit("update-available", json!({ "version": latest, "url": url }));
                    told = latest;
                }
            }
            std::thread::sleep(Duration::from_secs(24 * 3600));
        }
    });
}

fn latest_version() -> Option<String> {
    let agent = ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(10)).build();
    let res = agent.get(&format!("{RELEASES}/latest")).call().ok()?;
    tag_from_location(res.header("location")?)
}

fn tag_from_location(loc: &str) -> Option<String> {
    let tag = loc.rsplit_once("/tag/")?.1;
    let v = tag.trim_start_matches('v');
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.')).then(|| v.to_string())
}

/// Is version `a` newer than `b`? ("0.10.0" > "0.9.3")
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(newer("0.2.0", "0.1.0"));
        assert!(newer("0.10.0", "0.9.3"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.1.0", "0.2.0"));
        assert_eq!(tag_from_location("https://github.com/x/y/releases/tag/v0.3.1").as_deref(), Some("0.3.1"));
        assert_eq!(tag_from_location("https://github.com/x/y/releases"), None); // no releases yet
    }
}
