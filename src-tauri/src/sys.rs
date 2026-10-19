//! Answers about this computer, read locally. Nothing here touches the network
//! except `internet()`, which only opens (and drops) a TCP connection.

use crate::ask::Answer;
use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use sysinfo::{Disks, ProcessesToUpdate, System};

pub fn fmt_bytes(b: u64) -> String {
    const G: f64 = 1024.0 * 1024.0 * 1024.0;
    const M: f64 = 1024.0 * 1024.0;
    let f = b as f64;
    if f >= G {
        format!("{:.1} GB", f / G)
    } else {
        format!("{:.0} MB", f / M)
    }
}

pub fn fmt_secs(s: u64) -> String {
    let d = s / 86_400;
    let h = (s % 86_400) / 3600;
    let m = (s % 3600) / 60;
    match (d, h) {
        (0, 0) => format!("{m}m"),
        (0, _) => format!("{h}h {m}m"),
        _ => format!("{d}d {h}h"),
    }
}

/// Group helper processes under the app they belong to. On macOS the
/// outermost `Something.app` in the executable path is the app the user
/// knows ("Google Chrome", not "Google Chrome Helper (Renderer)").
fn app_name(p: &sysinfo::Process) -> String {
    if let Some(exe) = p.exe() {
        for comp in exe.components() {
            let s = comp.as_os_str().to_string_lossy();
            if let Some(stem) = s.strip_suffix(".app") {
                return stem.to_string();
            }
        }
    }
    let name = p.name().to_string_lossy().to_string();
    match name.find(" Helper") {
        Some(i) => name[..i].to_string(),
        None => name,
    }
}

pub fn memory() -> Answer {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let total = sys.total_memory();
    if total == 0 {
        return Answer::answer("I could not read memory just now.", vec![]);
    }
    let used = sys.used_memory();
    let mut by_app: HashMap<String, (u64, usize)> = HashMap::new();
    for p in sys.processes().values() {
        let e = by_app.entry(app_name(p)).or_default();
        e.0 += p.memory();
        e.1 += 1;
    }
    let mut apps: Vec<_> = by_app.into_iter().collect();
    apps.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    let top: Vec<String> = apps.iter().take(3).map(|(n, (b, _))| format!("{n} {}", fmt_bytes(*b))).collect();
    let mut lines = vec![format!(
        "{} of {} in use ({:.0}%)",
        fmt_bytes(used),
        fmt_bytes(total),
        used as f64 * 100.0 / total as f64
    )];
    for (n, (b, c)) in apps.iter().take(5) {
        lines.push(format!("{n} — {}, {c} process{}", fmt_bytes(*b), if *c == 1 { "" } else { "es" }));
    }
    Answer::answer(&top.join(", "), lines)
}

pub fn cpu() -> Answer {
    let mut sys = System::new();
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(500)));
    sys.refresh_cpu_usage();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let cores = sys.cpus().len().max(1) as f32;
    let total = sys.global_cpu_usage();
    let mut by_app: HashMap<String, f32> = HashMap::new();
    for p in sys.processes().values() {
        *by_app.entry(app_name(p)).or_default() += p.cpu_usage() / cores;
    }
    let mut apps: Vec<_> = by_app.into_iter().filter(|(_, u)| *u >= 0.5).collect();
    apps.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mood = if total < 25.0 { "taking it easy" } else if total < 70.0 { "fairly busy" } else { "working hard" };
    let lines = apps.iter().take(5).map(|(n, u)| format!("{n} — {u:.0}%")).collect();
    Answer::answer(&format!("Processor {total:.0}% — {mood}"), lines)
}

pub fn disk() -> Answer {
    let disks = Disks::new_with_refreshed_list();
    let mut seen = std::collections::HashSet::new();
    let mut lines = vec![];
    let mut first = None;
    for d in disks.list() {
        let mount = d.mount_point().to_string_lossy().to_string();
        if cfg!(target_os = "macos") && !(mount == "/" || mount.starts_with("/Volumes/")) {
            continue;
        }
        if d.total_space() == 0 || !seen.insert((d.total_space(), d.available_space())) {
            continue;
        }
        let label = if mount == "/" { "Macintosh HD".to_string() } else { mount.trim_start_matches("/Volumes/").to_string() };
        let line = format!("{label}: {} free of {}", fmt_bytes(d.available_space()), fmt_bytes(d.total_space()));
        if first.is_none() {
            first = Some(line.clone());
        }
        lines.push(line);
    }
    match first {
        Some(f) => Answer::answer(&f, if lines.len() > 1 { lines } else { vec![] }),
        None => Answer::answer("I could not read the disks just now.", vec![]),
    }
}

pub fn uptime() -> Answer {
    Answer::answer(&format!("Up for {} since the last restart", fmt_secs(System::uptime())), vec![])
}

pub fn battery() -> Answer {
    use starship_battery::units::ratio::percent;
    use starship_battery::units::time::second;
    use starship_battery::State;

    let Ok(manager) = starship_battery::Manager::new() else {
        return Answer::answer("I could not read the battery just now.", vec![]);
    };
    let Some(Ok(b)) = manager.batteries().ok().and_then(|mut it| it.next()) else {
        return Answer::answer("No battery here — this Mac runs on mains power.", vec![]);
    };
    let pct = b.state_of_charge().get::<percent>().round();
    let title = match b.state() {
        State::Charging => match b.time_to_full() {
            Some(t) => format!("Battery {pct}%, charging — full in {}", fmt_secs(t.get::<second>() as u64)),
            None => format!("Battery {pct}%, charging"),
        },
        State::Full => format!("Battery {pct}%, fully charged"),
        _ => match b.time_to_empty() {
            Some(t) => format!("Battery {pct}%, about {} left", fmt_secs(t.get::<second>() as u64)),
            None => format!("Battery {pct}%"),
        },
    };
    let mut lines = vec![];
    if pct <= 15.0 && b.state() != State::Charging {
        lines.push("That's low — plug in soon.".to_string());
    }
    Answer::answer(&title, lines)
}

pub fn internet() -> Answer {
    let targets: [SocketAddr; 2] = ["1.1.1.1:443".parse().unwrap(), "8.8.8.8:53".parse().unwrap()];
    let online = targets.iter().any(|a| TcpStream::connect_timeout(a, Duration::from_millis(1500)).is_ok());
    if online {
        Answer::answer("You're online.", vec![])
    } else {
        Answer::answer("Looks like you're offline.", vec!["I couldn't reach the internet just now.".into()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(fmt_bytes(3 * 1024 * 1024 * 1024 / 2), "1.5 GB");
        assert_eq!(fmt_bytes(512 * 1024 * 1024), "512 MB");
        assert_eq!(fmt_secs(59 * 60), "59m");
        assert_eq!(fmt_secs(90 * 60), "1h 30m");
        assert_eq!(fmt_secs(2 * 86_400 + 3 * 3600), "2d 3h");
    }

    #[test]
    fn live_queries_do_not_panic() {
        let _ = memory();
        let _ = disk();
        let _ = uptime();
        let _ = battery();
    }
}
