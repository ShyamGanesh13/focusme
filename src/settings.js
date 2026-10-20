// settings.js — every knob. Changes save as you make them.

import { invoke, listen, loadCharacterSvg } from "./lib/bridge.js";
import { Character, sanitizeSvg } from "./lib/character.js";

const $ = (id) => document.getElementById(id);
let cfg = await invoke("get_config");

// ------------------------------------------------------------ tabs
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("section[data-panel]").forEach((s) => s.classList.toggle("on", s.dataset.panel === b.dataset.tab));
  if (b.dataset.tab === "notes") renderNotes();
});

// ------------------------------------------------------------ save (debounced)
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await invoke("save_config", { cfg });
    $("saved").textContent = "Saved";
    setTimeout(() => ($("saved").textContent = ""), 1400);
  }, 250);
}

// ------------------------------------------------------------ simple bindings
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const binds = [
  ["userName", "value", () => cfg.pet.userName, (v) => (cfg.pet.userName = v.trim())],
  ["scale", "value", () => cfg.pet.scale, (v) => (cfg.pet.scale = num(v, 0.5, 2, 1))],
  ["speed", "value", () => cfg.pet.speed, (v) => (cfg.pet.speed = num(v, 0.5, 2, 1))],
  ["peek", "checked", () => cfg.pet.peek, (v) => (cfg.pet.peek = v)],
  ["wander", "checked", () => cfg.pet.wander, (v) => (cfg.pet.wander = v)],
  ["sleepy", "checked", () => cfg.pet.sleepy, (v) => (cfg.pet.sleepy = v)],
  ["follow", "checked", () => cfg.pet.follow, (v) => (cfg.pet.follow = v)],
  ["city", "value", () => cfg.weather.city, (v) => (cfg.weather.city = v.trim())],
  ["sessionMinutes", "value", () => cfg.session.minutes, (v) => (cfg.session.minutes = num(v, 1, 600, 25))],
  ["chimeOn", "checked", () => cfg.session.chime, (v) => (cfg.session.chime = v)],
  ["waterOn", "checked", () => cfg.water.enabled, (v) => (cfg.water.enabled = v)],
  ["waterEvery", "value", () => cfg.water.everyMinutes, (v) => (cfg.water.everyMinutes = num(v, 5, 480, 60))],
  ["bedOn", "checked", () => cfg.bedtime.enabled, (v) => (cfg.bedtime.enabled = v)],
  ["bedFrom", "value", () => cfg.bedtime.from, (v) => (cfg.bedtime.from = v || "23:00")],
  ["bedTo", "value", () => cfg.bedtime.to, (v) => (cfg.bedtime.to = v || "06:00")],
];

function fill() {
  for (const [id, prop, get] of binds) $(id)[prop] = get();
  $("scaleOut").textContent = Number(cfg.pet.scale).toFixed(2) + "×";
  $("speedOut").textContent = Number(cfg.pet.speed).toFixed(2) + "×";
  renderReminders();
  renderRoutines();
}

for (const [id, prop, , set] of binds) {
  const el = $(id);
  el.addEventListener(el.type === "range" || el.type === "text" ? "input" : "change", () => {
    set(el[prop]);
    if (id === "scale") $("scaleOut").textContent = Number(cfg.pet.scale).toFixed(2) + "×";
    if (id === "speed") $("speedOut").textContent = Number(cfg.pet.speed).toFixed(2) + "×";
    save();
  });
}

// ------------------------------------------------------------ character
let preview = null;
async function showCharacter(svgText) {
  $("charErr").hidden = true;
  preview && preview.destroy();
  preview = new Character($("charPreview"), svgText);
  const parts = preview.detected();
  $("charParts").textContent = parts.length
    ? "Animated parts found: " + parts.join(", ") + "."
    : "No named parts found — it will move as one piece. That's fine!";
}
(async () => showCharacter(await loadCharacterSvg()))();
setInterval(() => preview && preview.blink(), 3500);

$("charFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    if (f.size > 2 * 1024 * 1024) throw new Error("That SVG is over 2 MB — please simplify it.");
    const text = await f.text();
    sanitizeSvg(text); // throws if it isn't an SVG
    await showCharacter(text);
    await invoke("set_character", { svg: text });
    $("saved").textContent = "Character updated";
  } catch (err) {
    $("charErr").textContent = String(err.message || err);
    $("charErr").hidden = false;
  }
});
$("charReset").addEventListener("click", async () => {
  await invoke("reset_character");
  showCharacter(await (await fetch("characters/default.svg")).text());
});

// ------------------------------------------------------------ focus
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
listen("tick", ({ payload: p }) => {
  $("sessionState").textContent = p.sessionLeft != null ? `Session running — ${fmt(p.sessionLeft)} left.` : "No session running.";
});
$("sessionStart").addEventListener("click", () => invoke("start_session", { minutes: cfg.session.minutes }));
$("sessionStop").addEventListener("click", () => invoke("stop_session"));

// ------------------------------------------------------------ reminders
function defaultWhen() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderReminders() {
  const list = $("remList");
  list.replaceChildren();
  const rows = [...cfg.reminders].sort((a, b) => (a.done - b.done) || a.at.localeCompare(b.at));
  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No reminders yet.";
    list.appendChild(e);
    return;
  }
  for (const r of rows) {
    const item = document.createElement("div");
    item.className = "item" + (r.done ? " done" : "");
    const text = document.createElement("input");
    text.type = "text"; text.value = r.text; text.placeholder = "Remind me to…";
    text.addEventListener("input", () => { r.text = text.value; save(); });
    const when = document.createElement("input");
    when.type = "datetime-local"; when.value = r.at;
    when.addEventListener("change", () => { r.at = when.value; r.done = false; item.classList.remove("done"); save(); });
    const del = document.createElement("button");
    del.className = "x"; del.title = "Delete"; del.textContent = "×";
    del.addEventListener("click", () => { cfg.reminders = cfg.reminders.filter((x) => x !== r); save(); renderReminders(); });
    item.append(text, when, del);
    list.appendChild(item);
  }
}
$("remAdd").addEventListener("click", () => {
  cfg.reminders.push({ id: 0, text: "", at: defaultWhen(), done: false });
  renderReminders();
  const inputs = $("remList").querySelectorAll("input[type=text]");
  inputs.forEach((i) => { if (!i.value) i.focus(); });
});

// ------------------------------------------------------------ routines
function renderRoutines() {
  const list = $("routineList");
  if (!list) return;
  if (!cfg.routines) cfg.routines = [];
  list.replaceChildren();
  if (!cfg.routines.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No routines yet.";
    list.appendChild(e);
    return;
  }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  for (const r of cfg.routines) {
    const item = mk("div", "item routine" + (r.enabled === false ? " off" : ""));

    // top row: on/off · label · delete
    const top = mk("div", "rtop");
    const on = mk("input");
    on.type = "checkbox"; on.checked = r.enabled !== false; on.title = "Enable / disable";
    on.addEventListener("change", () => { r.enabled = on.checked; item.classList.toggle("off", !on.checked); save(); });
    const text = mk("input");
    text.type = "text"; text.value = r.label || ""; text.placeholder = "Nudge me to… (e.g. stand and stretch)";
    text.addEventListener("input", () => { r.label = text.value; save(); });
    const del = mk("button", "x", "×"); del.title = "Delete";
    del.addEventListener("click", () => { cfg.routines = cfg.routines.filter((x) => x !== r); save(); renderRoutines(); });
    top.append(on, text, del);

    // bottom row: every N min · active from–to
    const bot = mk("div", "rbot");
    const every = mk("input");
    every.type = "number"; every.min = "1"; every.max = "1440"; every.title = "How often";
    every.value = r.everyMinutes || 60;
    every.addEventListener("input", () => { r.everyMinutes = num(every.value, 1, 1440, 60); save(); });
    const from = mk("input"); from.type = "time"; from.value = r.from || ""; from.title = "Active from (blank = all day)";
    from.addEventListener("change", () => { r.from = from.value; save(); });
    const to = mk("input"); to.type = "time"; to.value = r.to || ""; to.title = "Active until (blank = all day)";
    to.addEventListener("change", () => { r.to = to.value; save(); });
    bot.append(mk("span", "lbl", "Every"), every, mk("span", "unit", "min"),
               mk("span", "dot", "·"),
               mk("span", "lbl", "Active"), from, mk("span", "unit", "–"), to);

    item.append(top, bot);
    list.appendChild(item);
  }
}
$("routineAdd").addEventListener("click", () => {
  if (!cfg.routines) cfg.routines = [];
  cfg.routines.push({ id: 0, label: "", everyMinutes: 120, enabled: true, from: "", to: "" });
  renderRoutines();
  const inputs = $("routineList").querySelectorAll("input[type=text]");
  inputs.forEach((i) => { if (!i.value) i.focus(); });
});

// ------------------------------------------------------------ notes
async function renderNotes() {
  const notes = await invoke("list_notes");
  const list = $("noteList");
  list.replaceChildren();
  if (!notes.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No notes yet. Double-click the pet and type one.";
    list.appendChild(e);
    return;
  }
  for (const n of notes) {
    const item = document.createElement("div");
    item.className = "item";
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = n.text;
    const when = document.createElement("div");
    when.className = "when";
    when.textContent = n.at.replace("T", " ");
    body.appendChild(when);
    const del = document.createElement("button");
    del.className = "x"; del.title = "Delete note"; del.textContent = "×";
    del.addEventListener("click", async () => { await invoke("delete_note", { id: n.id }); renderNotes(); });
    item.append(body, del);
    list.appendChild(item);
  }
}
listen("notes-changed", () => renderNotes());

// ------------------------------------------------------------ general
// "Open at login" reflects the saved setting (the OS login item is synced to it
// on every launch). Toggling it flips both the OS item and the stored preference.
$("autostart").checked = cfg.loginItem !== false;
$("autostart").addEventListener("change", async (e) => {
  const want = e.target.checked;
  try {
    const actual = await invoke("autostart_set", { enabled: want });
    e.target.checked = actual;
    cfg.loginItem = actual;
    save();
  } catch (err) {
    e.target.checked = !want;
    $("saved").textContent = "Couldn't change login item";
  }
});
$("version").textContent = await invoke("app_version").catch(() => "");
$("showPet").addEventListener("click", () => invoke("set_pet_visible", { visible: true }));
$("hidePet").addEventListener("click", () => invoke("set_pet_visible", { visible: false }));
$("quit").addEventListener("click", () => invoke("quit_app"));

// Another window (or a /remind in the chat) changed the config.
// While a list field is being edited, DON'T swap `cfg` or re-render: the
// reminder/routine inputs hold a reference to their row object, and replacing
// `cfg` would orphan it — further keystrokes would update a detached object
// while the next save wrote the stale copy (labels got truncated mid-typing).
// Our own debounced save already keeps disk in sync, so ignoring the echo is safe.
listen("config-changed", ({ payload }) => {
  const editing = document.activeElement && document.activeElement.closest("#remList, #routineList, input[type=text]");
  if (editing) return;
  cfg = payload;
  fill();
});

fill();
