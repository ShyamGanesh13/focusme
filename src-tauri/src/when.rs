//! Natural-ish reminder parsing: "call Kavi at 5pm", "stretch in 20 min",
//! "tomorrow 9am standup", "17:30 pay rent". The time can sit anywhere in
//! the sentence; whatever is left over is the reminder text.

use chrono::{Duration, NaiveDateTime, NaiveTime};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, PartialEq)]
pub enum WhenError {
    /// No time found in the sentence.
    NoTime,
    /// A time, but nothing to be reminded about.
    NoText,
}

struct Patterns {
    relative: Regex,
    tomorrow: Regex,
    today: Regex,
    ampm: Regex,
    h24: Regex,
    noon: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        relative: Regex::new(r"(?i)\bin\s+(\d{1,4})\s*(minutes?|mins?|m|hours?|hrs?|h)\b").unwrap(),
        tomorrow: Regex::new(r"(?i)\btomorrow\b").unwrap(),
        today: Regex::new(r"(?i)\btoday\b").unwrap(),
        ampm: Regex::new(r"(?i)\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b").unwrap(),
        h24: Regex::new(r"(?i)\b(?:at\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)\b").unwrap(),
        noon: Regex::new(r"(?i)\b(?:at\s+)?(noon|midnight)\b").unwrap(),
    })
}

fn cut(text: &mut String, range: std::ops::Range<usize>) {
    text.replace_range(range, " ");
}

/// Returns (what, when).
pub fn parse_reminder(input: &str, now: NaiveDateTime) -> Result<(String, NaiveDateTime), WhenError> {
    let p = patterns();
    let mut text = format!(" {} ", input.trim());
    let mut at: Option<NaiveDateTime> = None;

    if let Some(c) = p.relative.captures(&text) {
        let n: i64 = c[1].parse().unwrap_or(0);
        let unit = c[2].to_lowercase();
        let dur = if unit.starts_with('h') { Duration::hours(n) } else { Duration::minutes(n) };
        if n > 0 {
            at = Some(now + dur);
        }
        let r = c.get(0).unwrap().range();
        cut(&mut text, r);
    }

    let mut tomorrow = false;
    if let Some(m) = p.tomorrow.find(&text) {
        tomorrow = true;
        let r = m.range();
        cut(&mut text, r);
    }
    if let Some(m) = p.today.find(&text) {
        let r = m.range();
        cut(&mut text, r);
    }

    if at.is_none() {
        let mut time: Option<NaiveTime> = None;
        if let Some(c) = p.ampm.captures(&text) {
            let h: u32 = c[1].parse().unwrap_or(99);
            let m: u32 = c.get(2).map(|m| m.as_str().parse().unwrap_or(99)).unwrap_or(0);
            let pm = c[3].eq_ignore_ascii_case("pm");
            if (1..=12).contains(&h) && m < 60 {
                time = NaiveTime::from_hms_opt(h % 12 + if pm { 12 } else { 0 }, m, 0);
                let r = c.get(0).unwrap().range();
                cut(&mut text, r);
            }
        } else if let Some(c) = p.h24.captures(&text) {
            let h: u32 = c[1].parse().unwrap_or(99);
            let m: u32 = c[2].parse().unwrap_or(99);
            time = NaiveTime::from_hms_opt(h, m, 0);
            let r = c.get(0).unwrap().range();
            cut(&mut text, r);
        } else if let Some(c) = p.noon.captures(&text) {
            let h = if c[1].eq_ignore_ascii_case("noon") { 12 } else { 0 };
            time = NaiveTime::from_hms_opt(h, 0, 0);
            let r = c.get(0).unwrap().range();
            cut(&mut text, r);
        }

        if let Some(t) = time {
            let mut dt = now.date().and_time(t);
            // "tomorrow 9am", or a time that has already passed today
            if tomorrow || dt <= now {
                dt += Duration::days(1);
            }
            at = Some(dt);
        } else if tomorrow {
            at = Some((now.date() + Duration::days(1)).and_time(NaiveTime::from_hms_opt(9, 0, 0).unwrap()));
        }
    } else if tomorrow {
        at = at.map(|a| a + Duration::days(1));
    }

    let at = at.ok_or(WhenError::NoTime)?;
    let what = tidy(&text);
    if what.is_empty() {
        return Err(WhenError::NoText);
    }
    Ok((what, at))
}

fn tidy(s: &str) -> String {
    let mut w: Vec<&str> = s.split_whitespace().collect();
    // "remind me to call mum" / "to call mum at" -> "call mum"
    while let Some(first) = w.first() {
        let f = first.to_lowercase();
        if f == "me" || f == "to" || f == "about" {
            w.remove(0);
        } else {
            break;
        }
    }
    while let Some(last) = w.last() {
        let l = last.to_lowercase();
        if ["at", "on", "by", "in", "-", ","].contains(&l.as_str()) {
            w.pop();
        } else {
            break;
        }
    }
    w.join(" ").trim_matches(|c: char| c == ',' || c == '-').trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 19).unwrap().and_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn pm_later_today() {
        let (w, t) = parse_reminder("call Kavi at 5pm", at(10, 0)).unwrap();
        assert_eq!(w, "call Kavi");
        assert_eq!(t, at(17, 0));
    }

    #[test]
    fn relative_minutes() {
        let (w, t) = parse_reminder("stretch in 20 min", at(10, 0)).unwrap();
        assert_eq!(w, "stretch");
        assert_eq!(t, at(10, 20));
    }

    #[test]
    fn relative_hours_front() {
        let (w, t) = parse_reminder("in 2 hours check the oven", at(10, 0)).unwrap();
        assert_eq!(w, "check the oven");
        assert_eq!(t, at(12, 0));
    }

    #[test]
    fn tomorrow_morning() {
        let (w, t) = parse_reminder("tomorrow 9am standup", at(22, 0)).unwrap();
        assert_eq!(w, "standup");
        assert_eq!(t, at(9, 0) + Duration::days(1));
    }

    #[test]
    fn twenty_four_hour() {
        let (w, t) = parse_reminder("17:30 pay rent", at(10, 0)).unwrap();
        assert_eq!(w, "pay rent");
        assert_eq!(t, at(17, 30));
    }

    #[test]
    fn past_time_rolls_over() {
        let (_, t) = parse_reminder("wake up at 8am", at(10, 0)).unwrap();
        assert_eq!(t, at(8, 0) + Duration::days(1));
    }

    #[test]
    fn minutes_with_ampm() {
        let (w, t) = parse_reminder("me to join the call at 4:45 pm", at(10, 0)).unwrap();
        assert_eq!(w, "join the call");
        assert_eq!(t, at(16, 45));
    }

    #[test]
    fn noon() {
        let (w, t) = parse_reminder("lunch at noon", at(10, 0)).unwrap();
        assert_eq!(w, "lunch");
        assert_eq!(t, at(12, 0));
    }

    #[test]
    fn errors() {
        assert_eq!(parse_reminder("buy milk", at(10, 0)), Err(WhenError::NoTime));
        assert_eq!(parse_reminder("at 5pm", at(10, 0)), Err(WhenError::NoText));
    }
}
