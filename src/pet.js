// pet.js — what the pet does.
//
// character.js knows how to move a drawing; this file decides when: where
// the pet stands, when it wanders or dozes, how it reacts to a click, a drag,
// a reminder, and the chat box. Rust owns the clock and the system queries;
// this owns everything you can see.
//
// Every routine is an async chain gated on `epoch`. Anything that grabs the
// pet (a drag, a click, the chat box) bumps it, and whatever was running
// unwinds on its next check instead of fighting the new behaviour.

import { invoke, listen, inTauri, loadCharacterSvg } from "./lib/bridge.js";
import { Character } from "./lib/character.js";
import { chime } from "./lib/chime.js";

const $ = (id) => document.getElementById(id);
const petEl = $("pet"), rigEl = $("rig"), artEl = $("art");
const bubbleEl = $("bubble"), badgeEl = $("badge"), fxEl = $("fx");
const chatEl = $("chat"), chatLog = $("chatLog"), chatInput = $("chatInput");
const chatHint = $("chatHint"), chatSend = $("chatSend"), menuEl = $("menu");

if (!inTauri) $("previewDesk").hidden = false;

const log = (...a) => console.log("[pet]", ...a);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let cfg = await invoke("get_config");
let char = null;

// ------------------------------------------------------------ geometry
const BASE_H = 140;
let W = BASE_H, H = BASE_H;
let x = 120;          // left edge, CSS px
let lift = 0;         // px above the floor (the Dock line)
let facing = 1;       // 1 = right, -1 = left
let mode = "idle";    // idle | walk | sleep | drag | fall | chat
let bob = 0, tilt = 0, phase = 0;
let vx = 0, vy = 0;

const floorY = () => window.innerHeight;
const maxX = () => Math.max(0, window.innerWidth - W);
const petTop = () => floorY() - H - lift;

function applySize() {
  const s = clamp(Number(cfg.pet.scale) || 1, 0.4, 3);
  H = BASE_H * s;
  W = H * (char ? char.aspect : 1);
  petEl.style.width = W + "px";
  petEl.style.height = H + "px";
  x = clamp(x, 0, maxX());
}

function place() {
  petEl.style.transform = `translate(${x}px, ${petTop()}px)`;
  artEl.style.transform = `translateY(${-bob}px) rotate(${tilt}deg) scaleX(${facing})`;
}

function setBreathe(on) {
  petEl.classList.toggle("breathe", on);
}

// ------------------------------------------------------------ hit testing
// The overlay is click-through except over these rectangles.
let hold = false;
let lastHit = "";
function hitRects() {
  const pad = 6;
  const rects = [{ x: x - pad, y: petTop() - pad, w: W + pad * 2, h: H + pad * 2 }];
  for (const el of [chatEl, menuEl, bubbleEl.classList.contains("clickable") ? bubbleEl : null]) {
    if (el && !el.hidden) {
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    }
  }
  return rects;
}
function sendHit(force = false) {
  const rects = hitRects();
  const key = JSON.stringify(rects.map((r) => [Math.round(r.x / 3), Math.round(r.y / 3), Math.round(r.w), Math.round(r.h)])) + hold;
  if (!force && key === lastHit) return;
  lastHit = key;
  invoke("set_hitbox", { rects, hold }).catch(() => {});
}

// ------------------------------------------------------------ interruptible routines
let epoch = 0;
let walkTarget = null;
let onArrive = null;
function interrupt() {
  epoch++;
  walkTarget = null;
  onArrive = null;
  if (mode === "walk") mode = "idle";
  return epoch;
}
const stale = (mine) => mine !== epoch;

function pause(ms, mine) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (stale(mine) || performance.now() - t0 >= ms) { clearInterval(iv); resolve(); }
    }, 60);
  });
}

function walkTo(tx, mine) {
  return new Promise((resolve) => {
    if (stale(mine)) return resolve();
    mode = "walk";
    setBreathe(false);
    walkTarget = clamp(tx, 0, maxX());
    onArrive = () => { mode = "idle"; resolve(); };
    const iv = setInterval(() => { if (stale(mine)) { clearInterval(iv); resolve(); } else if (walkTarget === null) clearInterval(iv); }, 100);
  });
}

// ------------------------------------------------------------ the frame loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const speed = 70 * clamp(Number(cfg.pet.speed) || 1, 0.3, 3) * (H / BASE_H);

  if (mode === "walk" && walkTarget !== null) {
    const dir = Math.sign(walkTarget - x);
    if (dir !== 0) facing = dir;
    x += dir * speed * dt;
    phase += dt * 9 * clamp(Number(cfg.pet.speed) || 1, 0.3, 3);
    bob = Math.abs(Math.sin(phase)) * 6 * (H / BASE_H);
    tilt = Math.sin(phase) * 3;
    char && char.swing(phase);
    if (dir === 0 || (dir > 0 && x >= walkTarget) || (dir < 0 && x <= walkTarget)) {
      x = walkTarget;
      walkTarget = null;
      bob = 0; tilt = 0;
      char && char.restArms();
      const done = onArrive; onArrive = null; done && done();
    }
  } else if (mode === "fall") {
    vy += 2600 * dt;
    lift -= vy * dt;
    x = clamp(x + vx * dt, 0, maxX());
    vx *= 0.985;
    tilt += (clamp(vx * 0.02, -15, 15) - tilt) * 0.2;
    if (lift <= 0) { lift = 0; land(); }
  } else if (mode === "drag") {
    tilt += (clamp(-vx * 0.03, -28, 28) - tilt) * 0.25;
    vx *= 0.9;
  } else {
    bob *= 0.8;
    tilt *= 0.8;
  }

  place();
  sendHit();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------ speech + effects
let bubbleTimer = null;
function say(text, { ms = 3800, small = "", alert = false, clickable = false } = {}) {
  char && char.talk(Math.min(1600, 400 + text.length * 30));
  if (!chatEl.hidden) return; // the chat log shows it instead
  clearTimeout(bubbleTimer);
  bubbleEl.textContent = text;
  if (small) { const s = document.createElement("small"); s.textContent = small; bubbleEl.appendChild(s); }
  bubbleEl.classList.toggle("alert", alert);
  bubbleEl.classList.toggle("clickable", clickable);
  bubbleEl.hidden = false;
  bubbleTimer = setTimeout(hush, ms);
  sendHit(true);
}
function hush() {
  bubbleEl.hidden = true;
  bubbleEl.classList.remove("clickable", "alert");
  sendHit(true);
}
bubbleEl.addEventListener("click", hush);

function spawn(kind, text) {
  const s = document.createElement("span");
  s.className = "fx " + kind;
  s.textContent = text;
  s.style.left = x + W * (facing > 0 ? 0.62 : 0.38) + "px";
  s.style.top = petTop() + H * 0.12 + "px";
  s.style.setProperty("--dx", rand(-18, 22) + "px");
  fxEl.appendChild(s);
  s.addEventListener("animationend", () => s.remove());
}

// ------------------------------------------------------------ idle life
let lastInteract = performance.now();
let bedtime = false;
let forcedSleep = false;
const touched = () => { lastInteract = performance.now(); };

function shouldSleep() {
  if (forcedSleep || bedtime) return true;
  return cfg.pet.sleepy && performance.now() - lastInteract > 5 * 60 * 1000;
}

async function doze(mine) {
  mode = "sleep";
  setBreathe(false);
  petEl.classList.add("sleeping");
  char && char.setEyes(0);
  while (!stale(mine) && shouldSleep()) {
    spawn("z", "z");
    await pause(1500, mine);
  }
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  if (!stale(mine)) { mode = "idle"; setBreathe(true); }
}

async function brain() {
  const mine = interrupt();
  mode = "idle";
  setBreathe(true);
  await pause(400, mine);
  while (!stale(mine)) {
    if (shouldSleep()) { await doze(mine); continue; }
    const r = Math.random();
    if (cfg.pet.wander && r < 0.4) {
      // mostly short strolls; now and then a long walk across the Dock
      const far = Math.random() < 0.25;
      const span = far ? maxX() : Math.min(maxX(), 260 * (H / BASE_H));
      await walkTo(far ? rand(0, maxX()) : x + rand(-span, span), mine);
      setBreathe(true);
    } else if (r < 0.52) {
      char && char.tilt(rand(-9, 9));
    } else if (r < 0.57) {
      char && (await char.wave(2));
    }
    await pause(rand(3500, 9000), mine);
  }
}

(function blinkLoop() {
  if (char && mode !== "sleep") char.blink();
  setTimeout(blinkLoop, rand(2400, 6200));
})();

// ------------------------------------------------------------ eyes follow the pointer
function onCursor(p) {
  const near = Math.hypot(p.x - (x + W / 2), p.y - (petTop() + H / 2)) < Math.max(W, H) * 0.9;
  if (near && !forcedSleep && !bedtime) touched();
  if (!char || !cfg.pet.follow || mode === "sleep") return;
  const ex = x + W / 2, ey = petTop() + H * 0.45;
  char.look(((p.x - ex) / 260) * facing, (p.y - ey) / 220);
}

// ------------------------------------------------------------ grab, drop, pat
let press = null;
let clickTimer = null;

artEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  closeMenu();
  artEl.setPointerCapture(e.pointerId);
  press = { sx: e.clientX, sy: e.clientY, ox: e.clientX - x, oy: e.clientY - petTop(), lx: e.clientX, lt: performance.now(), dragging: false };
  hold = true;
  sendHit(true);
});

artEl.addEventListener("pointermove", (e) => {
  if (!press) return;
  if (!press.dragging && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > 5) {
    press.dragging = true;
    interrupt();
    if (!chatEl.hidden) closeChat(false);
    hush();
    mode = "drag";
    setBreathe(false);
    petEl.classList.remove("sleeping");
    forcedSleep = false;
    char && char.setEyes(1);
    touched();
  }
  if (press.dragging) {
    const now = performance.now();
    const dt = Math.max(1, now - press.lt) / 1000;
    vx = vx * 0.6 + ((e.clientX - press.lx) / dt) * 0.4;
    press.lx = e.clientX; press.lt = now;
    x = clamp(e.clientX - press.ox, 0, maxX());
    lift = Math.max(0, floorY() - H - (e.clientY - press.oy));
  }
});

function endPress(e) {
  if (!press) return;
  const wasDrag = press.dragging;
  press = null;
  hold = false;
  sendHit(true);
  if (wasDrag) {
    if (lift > 2) { mode = "fall"; vy = 0; vx = clamp(vx, -900, 900); }
    else land();
  } else if (e.type === "pointerup") {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(pat, 260); // a double-click cancels this
  }
}
artEl.addEventListener("pointerup", endPress);
artEl.addEventListener("pointercancel", endPress);

artEl.addEventListener("dblclick", (e) => {
  e.preventDefault();
  clearTimeout(clickTimer);
  openChat();
});

function land() {
  mode = "idle";
  tilt = 0;
  rigEl.animate(
    [{ transform: "scale(1.16, 0.8)" }, { transform: "scale(0.94, 1.07)" }, { transform: "scale(1, 1)" }],
    { duration: 420, easing: "ease-out" }
  );
  setTimeout(brain, 450);
}

const PAT_LINES = ["Hehe.", "That tickles!", "Hi!", "♪", "Thanks!"];
async function pat() {
  const wasSleeping = mode === "sleep";
  interrupt();
  forcedSleep = false;
  touched();
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  spawn("heart", "♥");
  rigEl.animate(
    [{ transform: "translateY(0)" }, { transform: "translateY(-16px) scale(0.98,1.03)" }, { transform: "translateY(0) scale(1.06,0.94)" }, { transform: "translateY(0)" }],
    { duration: 480, easing: "ease-out" }
  );
  if (wasSleeping) say("Oh! I'm up, I'm up.");
  else if (Math.random() < 0.35) say(PAT_LINES[Math.floor(Math.random() * PAT_LINES.length)], { ms: 1800 });
  setTimeout(brain, 600);
}

// ------------------------------------------------------------ chat
function shapeOf(t) {
  t = t.trim();
  if (t.startsWith("/")) return "do";
  if (t.endsWith("?") || /^(hi|hello|hey|hiya|yo|help)\b/i.test(t)) return "ask";
  return "note";
}
function reflect() {
  const t = chatInput.value;
  const k = t.trim() ? shapeOf(t) : "note";
  chatHint.textContent = { do: "Enter runs the command", ask: "Enter asks", note: "Enter saves a note" }[k];
  chatHint.className = k === "note" ? "" : k;
  chatSend.textContent = { do: "Run", ask: "Ask", note: "Save" }[k];
  chatSend.className = k === "note" ? "" : k;
}

function positionChat() {
  const w = 320;
  chatEl.style.left = clamp(x + W / 2 - w / 2, 8, window.innerWidth - w - 8) + "px";
  chatEl.style.bottom = window.innerHeight - petTop() + (badgeEl.hidden ? 14 : 34) + "px";
}

function openChat() {
  interrupt();
  forcedSleep = false;
  touched();
  hush();
  closeMenu();
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  mode = "chat";
  setBreathe(true);
  positionChat();
  chatEl.hidden = false;
  reflect();
  invoke("focus_pet").catch(() => {});
  setTimeout(() => chatInput.focus(), 30);
  sendHit(true);
}

function closeChat(resume = true) {
  chatEl.hidden = true;
  chatInput.blur();
  sendHit(true);
  if (resume) brain();
}

function addTurn(q, ans) {
  const p = document.createElement("p");
  p.className = "q";
  p.textContent = q;
  const a = document.createElement("div");
  a.className = "a pending";
  a.textContent = "…";
  chatLog.append(p, a);
  while (chatLog.children.length > 8) chatLog.firstChild.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
  return (res) => {
    a.className = "a " + (res.kind || "answer");
    a.textContent = "";
    const b = document.createElement("b");
    b.textContent = res.title;
    a.appendChild(b);
    if (res.lines && res.lines.length) {
      const ul = document.createElement("ul");
      res.lines.forEach((l) => { const li = document.createElement("li"); li.textContent = l; ul.appendChild(li); });
      a.appendChild(ul);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
    sendHit(true);
  };
}

async function submit(text) {
  text = text.trim();
  if (!text) return;
  chatInput.value = "";
  reflect();
  const finish = addTurn(text);
  let res;
  try {
    res = await invoke("ask", { text });
  } catch (e) {
    res = { kind: "error", title: "Something went wrong.", lines: [String(e)] };
  }
  finish(res);
  char && char.talk(900);
  act(res.action);
}

function act(action) {
  if (!action) return;
  if (action === "wave") char && char.wave(3);
  if (action === "sleep") { forcedSleep = true; closeChat(); }
  if (action === "hide") setTimeout(() => { closeChat(false); invoke("set_pet_visible", { visible: false }); }, 900);
  if (action === "quit") setTimeout(() => invoke("quit_app"), 900);
}

chatInput.addEventListener("input", reflect);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(chatInput.value); }
});
chatSend.addEventListener("click", () => submit(chatInput.value));
$("chips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-q]");
  if (b) submit(b.dataset.q);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!menuEl.hidden) closeMenu(); else if (!chatEl.hidden) closeChat(); }
});
window.addEventListener("blur", () => {
  if (!chatEl.hidden && !chatInput.value.trim()) closeChat();
});

// ------------------------------------------------------------ right-click menu
artEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = clamp(e.clientX, 4, window.innerWidth - r.width - 4) + "px";
  menuEl.style.top = clamp(e.clientY - r.height, 4, window.innerHeight - r.height - 4) + "px";
  sendHit(true);
});
function closeMenu() {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  sendHit(true);
}
menuEl.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  closeMenu();
  const a = b.dataset.act;
  if (a === "chat") openChat();
  if (a === "focus") invoke("start_session", {});
  if (a === "sleep") { forcedSleep = true; brain(); }
  if (a === "settings") invoke("open_settings");
  if (a === "hide") invoke("set_pet_visible", { visible: false });
  if (a === "quit") invoke("quit_app");
});
document.addEventListener("pointerdown", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
});

// ------------------------------------------------------------ events from Rust
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

listen("tick", ({ payload: p }) => {
  bedtime = !!p.bedtime;
  if (p.sessionLeft != null) {
    badgeEl.textContent = fmt(p.sessionLeft);
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
});
listen("session-started", ({ payload: m }) => {
  touched();
  say(`Focus time — ${m} min. I'll keep watch.`);
});
listen("session-stopped", () => { badgeEl.hidden = true; });
listen("session-done", () => {
  badgeEl.hidden = true;
  if (cfg.session.chime) chime("done");
  forcedSleep = false;
  touched();
  pat();
  setTimeout(() => say("Session done! Stand up and stretch for five.", { ms: 10000, alert: true }), 650);
});
listen("reminder", ({ payload: r }) => {
  chime("remind");
  forcedSleep = false;
  touched();
  brain();
  say(r.text, { ms: 120000, alert: true, clickable: true, small: "Reminder · click to dismiss" });
});
listen("water", () => {
  touched();
  say("Time for a sip of water.", { ms: 8000 });
  char && char.wave(1);
});
listen("bedtime", () => {
  say("It's getting late. Goodnight!", { ms: 6000 });
});
listen("cursor", ({ payload }) => onCursor(payload));
listen("open-chat", () => openChat());
listen("config-changed", ({ payload }) => {
  cfg = payload;
  applySize();
});
listen("character-changed", () => mountCharacter());
listen("pet-visible", ({ payload: v }) => { if (v) brain(); });

if (!inTauri) window.addEventListener("mousemove", (e) => onCursor({ x: e.clientX, y: e.clientY }));
window.addEventListener("resize", () => { applySize(); if (!chatEl.hidden) positionChat(); });

// ------------------------------------------------------------ start
async function mountCharacter() {
  const svg = await loadCharacterSvg();
  char && char.destroy();
  try {
    char = new Character(artEl, svg);
  } catch (e) {
    log("custom character failed, using default:", e.message);
    char = new Character(artEl, await (await fetch("characters/default.svg")).text());
  }
  applySize();
}

await mountCharacter();
x = clamp(window.innerWidth * 0.7, 0, maxX());
lift = window.innerHeight * 0.35; // arrive by dropping in
mode = "fall";
vy = 0;
requestAnimationFrame(frame);
setTimeout(() => {
  const name = (cfg.pet.userName || "").trim();
  say(name ? `Hi ${name}! Double-click me to chat.` : "Hi! Double-click me to chat.", { ms: 5000 });
}, 900);
