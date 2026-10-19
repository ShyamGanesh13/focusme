//! "weather?" — Open-Meteo (free, no API key). The city comes from the
//! question ("weather in Chennai?") or from Settings → Weather.

use crate::ask::Answer;
use serde_json::Value;
use std::time::Duration;

fn describe(code: i64) -> &'static str {
    match code {
        0 => "clear sky",
        1 => "mostly clear",
        2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "fog",
        51 | 53 | 55 => "drizzle",
        56 | 57 => "freezing drizzle",
        61 => "light rain",
        63 => "rain",
        65 => "heavy rain",
        66 | 67 => "freezing rain",
        71 => "light snow",
        73 => "snow",
        75 => "heavy snow",
        77 => "snow grains",
        80 => "light showers",
        81 => "showers",
        82 => "heavy showers",
        85 | 86 => "snow showers",
        95 => "thunderstorm",
        96 | 99 => "thunderstorm with hail",
        _ => "mixed weather",
    }
}

fn get(url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let mut req = ureq::get(url).timeout(Duration::from_secs(8));
    for (k, v) in query {
        req = req.query(k, v);
    }
    req.call().map_err(|e| e.to_string())?.into_json::<Value>().map_err(|e| e.to_string())
}

pub fn weather(city: &str) -> Answer {
    let city = city.trim();
    if city.is_empty() {
        return Answer::answer(
            "Which city?",
            vec!["Ask \"weather in Chennai?\", or set your city in Settings → Weather.".into()],
        );
    }
    match fetch(city) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[deskpal] weather failed: {e}");
            Answer::answer("I couldn't reach the weather service.", vec!["Check your connection and ask again.".into()])
        }
    }
}

fn fetch(city: &str) -> Result<Answer, String> {
    let geo = get(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[("name", city), ("count", "1"), ("language", "en"), ("format", "json")],
    )?;
    let Some(place) = geo["results"].get(0) else {
        return Ok(Answer::answer(&format!("I couldn't find a place called {city}."), vec![]));
    };
    let lat = place["latitude"].as_f64().ok_or("no latitude")?.to_string();
    let lon = place["longitude"].as_f64().ok_or("no longitude")?.to_string();
    let name = place["name"].as_str().unwrap_or(city);
    let region = place["admin1"].as_str().or(place["country"].as_str()).unwrap_or("");

    let f = get(
        "https://api.open-meteo.com/v1/forecast",
        &[
            ("latitude", &lat),
            ("longitude", &lon),
            ("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m"),
            ("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max"),
            ("timezone", "auto"),
            ("forecast_days", "1"),
        ],
    )?;
    let cur = &f["current"];
    let day = &f["daily"];
    let t = cur["temperature_2m"].as_f64().ok_or("no temperature")?;
    let place_label = if region.is_empty() { name.to_string() } else { format!("{name}, {region}") };
    let title = format!("{place_label}: {t:.0}°C, {}", describe(cur["weather_code"].as_i64().unwrap_or(-1)));
    let mut lines = vec![];
    if let (Some(feels), Some(hum), Some(wind)) = (
        cur["apparent_temperature"].as_f64(),
        cur["relative_humidity_2m"].as_f64(),
        cur["wind_speed_10m"].as_f64(),
    ) {
        lines.push(format!("Feels like {feels:.0}°C · humidity {hum:.0}% · wind {wind:.0} km/h"));
    }
    if let (Some(lo), Some(hi)) = (day["temperature_2m_min"][0].as_f64(), day["temperature_2m_max"][0].as_f64()) {
        let rain = day["precipitation_probability_max"][0].as_f64().unwrap_or(0.0);
        lines.push(format!("Today {lo:.0}°C to {hi:.0}°C, {rain:.0}% chance of rain"));
    }
    Ok(Answer::answer(&title, lines))
}
