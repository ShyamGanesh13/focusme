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
  renderDaily();
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
    const isSvg = f.type === "image/svg+xml" || f.name.toLowerCase().endsWith(".svg");
    if (isSvg && f.size > 2 * 1024 * 1024) throw new Error("That SVG is over 2 MB — please simplify it.");
    if (!isSvg && f.size > 20 * 1024 * 1024) throw new Error("That image is over 20 MB — please use a smaller one.");
    let text = isSvg ? await f.text() : await rasterToSvg(f);
    sanitizeSvg(text); // throws if it isn't an SVG
    // Shrink embedded pictures until the result fits the 2 MB save limit.
    let out = text;
    for (const px of [900, 700, 500, 350]) {
      out = await knockOutBackgrounds(text, px);
      if (out.length <= MAX_SAVE) break;
    }
    if (out.length > MAX_SAVE) throw new Error("That picture is too detailed to fit in 2 MB, even shrunk. Try a simpler image.");
    await invoke("set_character", { svg: out }); // save first, so a failure leaves the preview on the real character
    await showCharacter(out);
    $("saved").textContent = "Character updated";
  } catch (err) {
    $("charErr").textContent = String(err.message || err);
    $("charErr").hidden = false;
  }
});
// ---- pictures with a baked-in background
// Many "transparent" PNGs (AI stickers especially) actually have a painted
// checkerboard or white backdrop. Erase light, grey-ish pixels connected to the
// image edge; the figure's outline stops the fill so its insides are kept.
const MAX_SAVE = 2 * 1024 * 1024; // matches MAX_SVG_BYTES in commands.rs

async function rasterToSvg(file) {
  const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
  const img = await loadImg(url);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${img.naturalWidth} ${img.naturalHeight}"><image href="${url}" width="${img.naturalWidth}" height="${img.naturalHeight}"/></svg>`;
}

function loadImg(src) {
  return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("Couldn't read that image.")); i.src = src; });
}

// maxPx: longest side for embedded pictures. The pet is at most 420pt tall, so
// 900px stays sharp on Retina; smaller is used only when 900 won't fit 2 MB.
async function knockOutBackgrounds(svgText, maxPx) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const imgs = [...doc.querySelectorAll("image")].filter((el) => /^data:image\/(png|jpe?g|webp)/.test(el.getAttribute("href") || el.getAttribute("xlink:href") || ""));
  if (!imgs.length) return svgText;
  for (const el of imgs) {
    const out = await clearBackdrop(el.getAttribute("href") || el.getAttribute("xlink:href"), maxPx);
    if (out) { el.removeAttribute("xlink:href"); el.setAttribute("href", out); }
  }
  doc.querySelectorAll("metadata").forEach((m) => m.remove()); // drop bulky C2PA blobs
  return new XMLSerializer().serializeToString(doc);
}

// Returns a new PNG data URL, or null when the picture already has real transparency.
async function clearBackdrop(src, maxPx) {
  const img = await loadImg(src);
  const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h);
  const px = data.data;
  // Already transparent around the edge? Leave it alone.
  let clear = 0;
  for (let x = 0; x < w; x++) if (px[x * 4 + 3] < 250 || px[((h - 1) * w + x) * 4 + 3] < 250) clear++;
  if (clear > w * 0.5) return k < 1 ? cv.toDataURL("image/png") : null;

  const isBackdrop = (i) => {
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    return Math.min(r, gg, b) > 185 && Math.max(r, gg, b) - Math.min(r, gg, b) < 28; // light and grey/white
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (!seen[p] && isBackdrop(p * 4)) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(), x = p % w;
    px[p * 4 + 3] = 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  // Soften the cut: half-fade any kept pixel that touches a removed one.
  for (let p = 0; p < w * h; p++) {
    if (seen[p]) continue;
    const x = p % w;
    if ((x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (p >= w && seen[p - w]) || (p < w * (h - 1) && seen[p + w])) px[p * 4 + 3] = 140;
  }
  g.putImageData(data, 0, 0);
  return cv.toDataURL("image/png");
}

$("charReset").addEventListener("click", async () => {
  await invoke("reset_character");
  await showCharacter(await (await fetch("characters/default.svg")).text());
  $("saved").textContent = "Character reset to Pip";
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

// ------------------------------------------------------------ daily reminders
function renderDaily() {
  const list = $("dailyList");
  if (!list) return;
  if (!cfg.daily) cfg.daily = [];
  list.replaceChildren();
  if (!cfg.daily.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No daily reminders yet.";
    list.appendChild(e);
    return;
  }
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  for (const d of cfg.daily) {
    const item = mk("div", "item routine" + (d.enabled === false ? " off" : ""));

    const top = mk("div", "rtop");
    const on = mk("input");
    on.type = "checkbox"; on.checked = d.enabled !== false; on.title = "Enable / disable";
    on.addEventListener("change", () => { d.enabled = on.checked; item.classList.toggle("off", !on.checked); save(); });
    const text = mk("input");
    text.type = "text"; text.value = d.label || ""; text.placeholder = "Remind me to… (e.g. have chia seeds)";
    text.addEventListener("input", () => { d.label = text.value; save(); });
    const del = mk("button", "x", "×"); del.title = "Delete";
    del.addEventListener("click", () => { cfg.daily = cfg.daily.filter((x) => x !== d); save(); renderDaily(); });
    top.append(on, text, del);

    const bot = mk("div", "rbot");
    const time = mk("input"); time.type = "time"; time.value = d.time || "09:00"; time.title = "Time each day";
    time.addEventListener("change", () => { d.time = time.value || "09:00"; save(); });
    bot.append(mk("span", "lbl", "Every day at"), time);

    item.append(top, bot);
    list.appendChild(item);
  }
}
$("dailyAdd").addEventListener("click", () => {
  if (!cfg.daily) cfg.daily = [];
  cfg.daily.push({ id: 0, label: "", time: "09:00", enabled: true });
  renderDaily();
  const inputs = $("dailyList").querySelectorAll("input[type=text]");
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
    e.textContent = "No notes yet. Triple-tap the pet and type one.";
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
  const editing = document.activeElement && document.activeElement.closest("#remList, #routineList, #dailyList, input[type=text]");
  if (editing) return;
  cfg = payload;
  fill();
});

fill();
