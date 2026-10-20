// Tauri bridge with an in-browser mock.
//
// Inside the app, `invoke`/`listen` go to Rust. Opened in a normal browser
// (npm run preview), a small mock answers instead, so the pet and the
// settings window can be designed without rebuilding the Rust side.
// `window.__mockEmit(event, payload)` fires events by hand while testing.

const T = window.__TAURI__;
export const inTauri = !!T;

const listeners = new Map();
function mockEmit(name, payload) {
  (listeners.get(name) || []).forEach((fn) => fn({ event: name, payload }));
}
window.__mockEmit = mockEmit;

const mock = (() => {
  let cfg = {
    pet: { userName: "", scale: 1, speed: 1, wander: true, sleepy: true, follow: true },
    session: { minutes: 25, chime: true },
    water: { enabled: false, everyMinutes: 60 },
    bedtime: { enabled: false, from: "23:00", to: "06:00" },
    weather: { city: "Chennai" },
    reminders: [],
  };
  let notes = [];
  let character = null;
  let sessionEnd = 0;
  let sessionTotal = 0;
  setInterval(() => {
    const left = sessionEnd ? Math.max(0, Math.round((sessionEnd - Date.now()) / 1000)) : null;
    if (sessionEnd && left === 0) { sessionEnd = 0; mockEmit("session-done", sessionTotal / 60); }
    mockEmit("tick", { sessionLeft: sessionEnd ? left : null, sessionTotal: sessionEnd ? sessionTotal : null, bedtime: false });
  }, 1000);
  const stamp = () => new Date().toISOString().slice(0, 16);

  function answer(text) {
    const t = text.trim();
    if (t.startsWith("/")) {
      const [head, ...rest] = t.slice(1).split(/\s+/);
      if (head === "timer") {
        const m = Number(rest[0]) || cfg.session.minutes;
        sessionEnd = Date.now() + m * 60000; sessionTotal = m * 60;
        mockEmit("session-started", m);
        return { kind: "command", title: `Focus session started — ${m} min. You've got this.`, lines: [], action: "session" };
      }
      if (head === "stop") { sessionEnd = 0; mockEmit("session-stopped"); return { kind: "command", title: "Focus session stopped.", lines: [] }; }
      if (head === "sleep") return { kind: "command", title: "Nap time…", lines: [], action: "sleep" };
      if (head === "hide") return { kind: "command", title: "Hiding.", lines: [], action: "hide" };
      if (head === "remind") return { kind: "command", title: `I'll remind you: ${rest.join(" ")}`, lines: [] };
      return { kind: "error", title: `I don't know /${head}.`, lines: ["Try /help"] };
    }
    if (/^(hi|hello|hey)\b/i.test(t)) return { kind: "answer", title: cfg.pet.userName ? `Hi ${cfg.pet.userName}!` : "Hi there!", lines: ["Ask me something, or tell me what to do."], action: "wave" };
    if (t.endsWith("?")) {
      if (/battery/i.test(t)) return { kind: "answer", title: "Battery 72%, about 3h 10m left", lines: [] };
      if (/memory|ram/i.test(t)) return { kind: "answer", title: "Google Chrome 2.1 GB, Code 1.4 GB, Slack 0.6 GB", lines: ["11.2 GB of 16.0 GB in use (70%)"] };
      if (/weather|rain/i.test(t)) return { kind: "answer", title: "Chennai, Tamil Nadu: 31°C, partly cloudy", lines: ["Feels like 36°C · humidity 70% · wind 14 km/h", "Today 27°C to 33°C, 40% chance of rain"] };
      if (/timer|session|focus/i.test(t)) {
        const left = sessionEnd ? Math.max(0, Math.round((sessionEnd - Date.now()) / 60000)) : null;
        return { kind: "answer", title: left === null ? "No focus session running." : `${left} min left in this session.`, lines: left === null ? ["Start one with /timer 25"] : [] };
      }
      if (/cpu|slow/i.test(t)) return { kind: "answer", title: "CPU 23% busy", lines: ["Google Chrome 12%, Code 6%"] };
      if (/disk|storage/i.test(t)) return { kind: "answer", title: "182 GB free of 494 GB", lines: [] };
      if (/internet|online/i.test(t)) return { kind: "answer", title: "You're online.", lines: [] };
      if (/uptime/i.test(t)) return { kind: "answer", title: "Up 3 days, 4 hours", lines: [] };
      if (/reminder/i.test(t)) return { kind: "answer", title: cfg.reminders.length ? `${cfg.reminders.length} reminders` : "No reminders set.", lines: [] };
      if (/note/i.test(t)) return { kind: "answer", title: notes.length ? `${notes.length} notes` : "No notes yet.", lines: notes.slice(-3).map((n) => n.text) };
      if (/time|date/i.test(t)) return { kind: "answer", title: new Date().toLocaleString(), lines: [] };
      return { kind: "error", title: "I don't know that one yet.", lines: ["Try: battery? memory? weather? disk? timer?"] };
    }
    notes.push({ id: Date.now(), text: t, at: stamp() });
    mockEmit("notes-changed");
    return { kind: "note", title: `Noted. That's ${notes.length} note${notes.length === 1 ? "" : "s"}.`, lines: [] };
  }

  return async (cmd, args = {}) => {
    switch (cmd) {
      case "get_config": return structuredClone(cfg);
      case "save_config": cfg = structuredClone(args.cfg); mockEmit("config-changed", cfg); return null;
      case "ask": await new Promise((r) => setTimeout(r, 250)); return answer(args.text);
      case "list_notes": return [...notes].reverse();
      case "add_note": notes.push({ id: Date.now(), text: args.text, at: stamp() }); return [...notes].reverse();
      case "delete_note": notes = notes.filter((n) => n.id !== args.id); return [...notes].reverse();
      case "status": return { sessionLeft: sessionEnd ? Math.round((sessionEnd - Date.now()) / 1000) : null, sessionTotal: sessionEnd ? sessionTotal : null };
      case "start_session": { const m = args.minutes || cfg.session.minutes; sessionEnd = Date.now() + m * 60000; sessionTotal = m * 60; mockEmit("session-started", m); return null; }
      case "stop_session": sessionEnd = 0; mockEmit("session-stopped"); return null;
      case "get_character": return character;
      case "set_character": character = args.svg; mockEmit("character-changed"); return null;
      case "reset_character": character = null; mockEmit("character-changed"); return null;
      case "app_version": return "0.1.0 (browser preview)";
      case "autostart_get": return false;
      case "autostart_set": return !!args.enabled;
      default: return null; // set_hitbox, focus_pet, open_settings, quit_app, set_pet_visible
    }
  };
})();

export const invoke = T ? T.core.invoke : mock;
export const listen = T
  ? T.event.listen
  : async (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => listeners.set(name, listeners.get(name).filter((f) => f !== fn));
    };
// App-wide: reaches every window (each monitor's pet), including this one.
export const emit = T ? T.event.emit : async (name, payload) => mockEmit(name, payload);

/** Load the user's SVG if they set one, else the bundled placeholder. */
export async function loadCharacterSvg() {
  const custom = await invoke("get_character").catch(() => null);
  if (custom) return custom;
  const res = await fetch("characters/default.svg");
  return res.text();
}
