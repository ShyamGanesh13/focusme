//! The chat box brain. No language model: a line is sorted by its shape
//! (`/command`, `question?`, or a note), and questions are matched to an
//! intent by keywords. Fast, offline, predictable.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// "answer" | "note" | "command" | "error"
    pub kind: String,
    /// One line — what the pet says in its speech bubble.
    pub title: String,
    /// Extra detail shown in the chat log.
    pub lines: Vec<String>,
    /// Something the frontend should do after showing the answer:
    /// "hide" | "settings" | "quit" | "session" | "sleep" | "wave".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

impl Answer {
    fn make(kind: &str, title: &str, lines: Vec<String>) -> Self {
        Self { kind: kind.into(), title: title.into(), lines, action: None }
    }
    pub fn answer(title: &str, lines: Vec<String>) -> Self { Self::make("answer", title, lines) }
    pub fn note(title: &str) -> Self { Self::make("note", title, vec![]) }
    pub fn command(title: &str) -> Self { Self::make("command", title, vec![]) }
    pub fn error(title: &str, lines: Vec<String>) -> Self { Self::make("error", title, lines) }
    pub fn with_action(mut self, a: &str) -> Self {
        self.action = Some(a.into());
        self
    }
}

#[derive(Debug, PartialEq)]
pub enum Shape {
    Command,
    Question,
    Note,
}

const GREETINGS: &[&str] = &["hi", "hello", "hey", "hiya", "yo", "good morning", "good evening", "good afternoon"];

fn norm(s: &str) -> String {
    s.trim().trim_end_matches(['?', '!', '.']).trim().to_lowercase()
}

pub fn is_greeting(s: &str) -> bool {
    let n = norm(s);
    GREETINGS.iter().any(|g| n == *g || n.starts_with(&format!("{g} ")) && n.split_whitespace().count() <= 3)
}

/// "/x" runs, "x?" (or a bare greeting / "help") asks, anything else is a note.
pub fn classify(s: &str) -> Shape {
    let t = s.trim();
    if t.starts_with('/') {
        Shape::Command
    } else if t.ends_with('?') || is_greeting(t) || norm(t) == "help" {
        Shape::Question
    } else {
        Shape::Note
    }
}

#[derive(Debug, PartialEq)]
pub enum Intent {
    Greeting,
    Help,
    Battery,
    Memory,
    Cpu,
    Disk,
    Uptime,
    Internet,
    Weather(Option<String>),
    Timer,
    Notes,
    Reminders,
    Clock,
    Name,
    Unknown,
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

fn weather_place() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\b(?:in|at|for)\s+([\p{L} .'-]{2,60})\??\s*$").unwrap())
}

pub fn intent(q: &str) -> Intent {
    if is_greeting(q) {
        return Intent::Greeting;
    }
    let w = words(q);
    let has = |set: &[&str]| w.iter().any(|x| set.contains(&x.as_str()));

    if has(&["weather", "rain", "raining", "rainy", "temperature", "forecast", "sunny", "umbrella", "humid", "humidity", "hot", "cold"]) {
        let place = weather_place()
            .captures(q.trim())
            .map(|c| c[1].trim().to_string())
            .filter(|p| !p.is_empty() && !["today", "tomorrow", "here"].contains(&p.to_lowercase().as_str()));
        return Intent::Weather(place);
    }
    if has(&["help", "commands"]) || norm(q).contains("what can you do") {
        return Intent::Help;
    }
    if has(&["battery", "charge", "charging", "plugged", "power"]) {
        return Intent::Battery;
    }
    if has(&["memory", "ram", "mem", "hog", "hogging", "eating"]) {
        return Intent::Memory;
    }
    if has(&["cpu", "processor", "slow", "lag", "lagging", "laggy", "busy", "load"]) {
        return Intent::Cpu;
    }
    if has(&["disk", "disks", "storage", "space", "drive", "drives", "ssd"]) {
        return Intent::Disk;
    }
    if has(&["uptime", "restart", "restarted", "reboot", "rebooted", "boot", "booted"]) {
        return Intent::Uptime;
    }
    if has(&["internet", "online", "offline", "wifi", "wi-fi", "network", "connected"]) {
        return Intent::Internet;
    }
    if has(&["timer", "session", "focus", "pomodoro", "left"]) {
        return Intent::Timer;
    }
    if has(&["reminder", "reminders", "remind"]) {
        return Intent::Reminders;
    }
    if has(&["note", "notes"]) {
        return Intent::Notes;
    }
    if has(&["time", "date", "day", "today"]) {
        return Intent::Clock;
    }
    if has(&["name", "who"]) {
        return Intent::Name;
    }
    Intent::Unknown
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Timer(Option<u32>),
    Stop,
    Remind(String),
    Note(String),
    /// Repeating water reminder: on/off, and how often (minutes).
    Water { on: bool, minutes: Option<u32> },
    /// A custom repeating routine: every `minutes`, nudge with `text`.
    /// `minutes == 0` means the interval couldn't be parsed.
    Every { minutes: u32, text: String },
    Hide,
    Settings,
    Quit,
    Sleep,
    Help,
    Unknown(String),
}

/// First run of digits anywhere in the text, e.g. "5mins" / "5 min" / "in 5" -> 5.
fn first_number(s: &str) -> Option<u32> {
    let digits: String = s.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}

fn to_minutes(n: u32, unit: &str) -> u32 {
    if unit.to_lowercase().starts_with('h') { n.saturating_mul(60) } else { n }
}

/// Pull an interval + label out of a `/every` body. Understands a leading
/// number ("120 stand", "2h stretch") or an inline "every N<unit>" phrase
/// ("stand and work for 20 mins every 2hrs"). Returns (minutes, label).
fn parse_every(rest: &str) -> Option<(u32, String)> {
    static EVERY: OnceLock<Regex> = OnceLock::new();
    static LEAD: OnceLock<Regex> = OnceLock::new();
    let every = EVERY.get_or_init(|| Regex::new(r"(?i)\bevery\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)?\b").unwrap());
    let lead = LEAD.get_or_init(|| Regex::new(r"(?i)^\s*(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)?\b").unwrap());

    if let Some(c) = every.captures(rest) {
        let n: u32 = c[1].parse().ok()?;
        let unit = c.get(2).map(|m| m.as_str()).unwrap_or("m");
        let m = c.get(0).unwrap();
        let label = format!("{} {}", rest[..m.start()].trim(), rest[m.end()..].trim());
        return Some((to_minutes(n, unit).clamp(1, 1440), label.trim().to_string()));
    }
    if let Some(c) = lead.captures(rest) {
        let n: u32 = c[1].parse().ok()?;
        let unit = c.get(2).map(|m| m.as_str()).unwrap_or("m");
        let m = c.get(0).unwrap();
        return Some((to_minutes(n, unit).clamp(1, 1440), rest[m.end()..].trim().to_string()));
    }
    None
}

pub fn command(s: &str) -> Command {
    let t = s.trim().trim_start_matches('/');
    let (head, rest) = match t.find(char::is_whitespace) {
        Some(i) => (&t[..i], t[i..].trim()),
        None => (t, ""),
    };
    match head.to_lowercase().as_str() {
        "timer" | "focus" | "pomodoro" | "start" => {
            Command::Timer(first_number(rest).map(|n| n.clamp(1, 600)))
        }
        "stop" | "end" => Command::Stop,
        "water" | "hydrate" => {
            let lower = rest.to_lowercase();
            if lower.starts_with("off") || lower.starts_with("stop") || lower.starts_with("no") {
                Command::Water { on: false, minutes: None }
            } else {
                Command::Water { on: true, minutes: first_number(rest).map(|n| n.clamp(1, 480)) }
            }
        }
        "every" | "routine" | "repeat" => match parse_every(rest) {
            Some((minutes, text)) => Command::Every { minutes, text },
            None => Command::Every { minutes: 0, text: rest.to_string() },
        },
        "remind" | "reminder" | "r" => Command::Remind(rest.to_string()),
        "note" | "n" => Command::Note(rest.to_string()),
        "hide" => Command::Hide,
        "settings" | "prefs" | "preferences" => Command::Settings,
        "quit" | "exit" | "bye" => Command::Quit,
        "sleep" | "nap" => Command::Sleep,
        "help" | "?" => Command::Help,
        other => Command::Unknown(other.to_string()),
    }
}

pub fn help() -> Answer {
    Answer::answer(
        "Here's what I understand",
        vec![
            "battery?  memory?  cpu?  disk?  uptime?  internet?".into(),
            "weather?  ·  weather in Chennai?".into(),
            "timer?  notes?  reminders?  time?".into(),
            "/timer 25  ·  /stop  ·  /remind call Kavi at 5pm".into(),
            "/every 2h stand and stretch  ·  a repeating nudge".into(),
            "/water 10  ·  a drink-water nudge every 10 min  (/water off)".into(),
            "/sleep  ·  /hide  ·  /settings  ·  /quit".into(),
            "Anything else you type is saved as a note.".into(),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes() {
        assert_eq!(classify("/timer 25"), Shape::Command);
        assert_eq!(classify("battery?"), Shape::Question);
        assert_eq!(classify("hi"), Shape::Question);
        assert_eq!(classify("Hello there"), Shape::Question);
        assert_eq!(classify("help"), Shape::Question);
        assert_eq!(classify("buy milk on the way home"), Shape::Note);
        assert_eq!(classify("hiking trip ideas"), Shape::Note);
    }

    #[test]
    fn intents() {
        assert_eq!(intent("battery?"), Intent::Battery);
        assert_eq!(intent("what's hogging my ram?"), Intent::Memory);
        assert_eq!(intent("why is it so slow?"), Intent::Cpu);
        assert_eq!(intent("how much disk space?"), Intent::Disk);
        assert_eq!(intent("am I online?"), Intent::Internet);
        assert_eq!(intent("weather?"), Intent::Weather(None));
        assert_eq!(intent("weather in Coimbatore?"), Intent::Weather(Some("Coimbatore".into())));
        assert_eq!(intent("will it rain today?"), Intent::Weather(None));
        assert_eq!(intent("how much time left on the timer?"), Intent::Timer);
        assert_eq!(intent("what time is it?"), Intent::Clock);
        assert_eq!(intent("notes?"), Intent::Notes);
        assert_eq!(intent("hey"), Intent::Greeting);
        assert_eq!(intent("what is love?"), Intent::Unknown);
    }

    #[test]
    fn commands() {
        assert_eq!(command("/timer 25"), Command::Timer(Some(25)));
        assert_eq!(command("/timer"), Command::Timer(None));
        assert_eq!(command("/pomodoro 50m"), Command::Timer(Some(50)));
        assert_eq!(command("/remind call Kavi at 5pm"), Command::Remind("call Kavi at 5pm".into()));
        assert_eq!(command("/QUIT"), Command::Quit);
        assert_eq!(command("/water 10"), Command::Water { on: true, minutes: Some(10) });
        assert_eq!(command("/water 5mins"), Command::Water { on: true, minutes: Some(5) });
        assert_eq!(command("/water"), Command::Water { on: true, minutes: None });
        assert_eq!(command("/water off"), Command::Water { on: false, minutes: None });
        assert_eq!(command("/timer 25mins"), Command::Timer(Some(25)));
        assert_eq!(command("/dance"), Command::Unknown("dance".into()));
    }

    #[test]
    fn every() {
        assert_eq!(command("/every 120 stand and stretch"), Command::Every { minutes: 120, text: "stand and stretch".into() });
        assert_eq!(command("/every 2h stand and stretch"), Command::Every { minutes: 120, text: "stand and stretch".into() });
        assert_eq!(command("/every 90m take a walk"), Command::Every { minutes: 90, text: "take a walk".into() });
        assert_eq!(command("/every 30 drink tea"), Command::Every { minutes: 30, text: "drink tea".into() });
        // inline "every N<unit>" phrase, as a person would naturally type it
        assert_eq!(
            command("/every stand and work for 20 mins every 2hrs"),
            Command::Every { minutes: 120, text: "stand and work for 20 mins".into() }
        );
        // no interval at all
        assert_eq!(command("/every stand up"), Command::Every { minutes: 0, text: "stand up".into() });
        assert_eq!(command("/repeat 45min hydrate"), Command::Every { minutes: 45, text: "hydrate".into() });
    }
}
