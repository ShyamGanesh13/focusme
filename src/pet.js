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
let sx = 1, sy = 1;   // art squash/stretch while walking
let vx = 0, vy = 0;

const floorY = () => window.innerHeight;
const maxX = () => Math.max(0, window.innerWidth - W);
const petTop = () => floorY() - H - lift;

// The pet lives in the bottom-right corner and only strolls within a small
// zone there — a few steps, not the whole bar. Dragging can still take it
// anywhere; it walks back into the zone when you let go.
const EDGE_GAP = 16;
const roamMax = () => Math.max(0, maxX() - EDGE_GAP);
const roamMin = () => Math.max(0, roamMax() - 3.0 * W);

// ------------------------------------------------------------ peek mode
// When on, the pet rests hidden just below the bottom edge and only slides up
// for a nudge (reminder/routine/water/timer), the chat, or the menu — then
// slides away. `shown` eases 0 (tucked away) → 1 (standing in the corner).
let peekMode = !!cfg.pet.peek;
let shown = peekMode ? 0 : 1;
let peekUntil = 0; // performance.now() timestamp to stay out until
const PEEK = { nudge: 9000, long: 12000, quick: 1400 };
function peekFor(ms) {
  if (peekMode) peekUntil = Math.max(peekUntil, performance.now() + ms);
}
function wantShown() {
  if (!peekMode) return 1;
  if (sessionActive) return 1;                 // stay out through a focus session (timer visible)
  if (!chatEl.hidden || !menuEl.hidden) return 1;
  return performance.now() < peekUntil ? 1 : 0;
}

function applySize() {
  const s = clamp(Number(cfg.pet.scale) || 1, 0.4, 3);
  H = BASE_H * s;
  W = H * (char ? char.aspect : 1);
  petEl.style.width = W + "px";
  petEl.style.height = H + "px";
  artEl.style.transformOrigin = "50% 100%"; // bounce/squash pivots on the feet
  // keep it parked in the corner zone unless it's being handled
  if (mode === "drag" || mode === "fall") {
    x = clamp(x, 0, maxX());
  } else {
    x = clamp(x, roamMin(), roamMax());
  }
}

function place() {
  const drop = (1 - shown) * (H + 60); // how far below the floor while hidden
  petEl.style.transform = `translate(${x}px, ${petTop() + drop}px)`;
  artEl.style.transform = `translateY(${-bob}px) rotate(${tilt}deg) scaleX(${facing * sx}) scaleY(${sy})`;
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
  // While tucked away (peek mode), the pet catches no clicks — the whole
  // overlay stays click-through so nothing underneath is blocked.
  const rects = shown > 0.6 ? [{ x: x - pad, y: petTop() - pad, w: W + pad * 2, h: H + pad * 2 }] : [];
  for (const el of [chatEl, menuEl, badgeEl.hidden ? null : badgeEl, bubbleEl.classList.contains("clickable") ? bubbleEl : null]) {
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
    phase += dt * 8 * clamp(Number(cfg.pet.speed) || 1, 0.3, 3);
    const step = Math.abs(Math.sin(phase));   // 0 at footfall, 1 mid-stride
    bob = step * 7 * (H / BASE_H);             // bounce up each step
    tilt = Math.sin(phase * 0.5) * 5;          // slow left/right waddle
    sy = 1 - 0.05 * step;                      // stretch up as it rises
    sx = 1 + 0.035 * step;
    char && char.swing(phase);                 // (moves arms if the SVG has them)
    if (dir === 0 || (dir > 0 && x >= walkTarget) || (dir < 0 && x <= walkTarget)) {
      x = walkTarget;
      walkTarget = null;
      bob = 0; tilt = 0; sx = 1; sy = 1;
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
    sx += (1 - sx) * 0.2;
    sy += (1 - sy) * 0.2;
  }

  // Peek: ease toward hidden/shown, and clear a lingering bubble as it leaves.
  const target = wantShown();
  shown += (target - shown) * clamp(dt * 9, 0, 1);
  if (Math.abs(shown - target) < 0.002) shown = target;
  if (peekMode && target === 0 && chatEl.hidden && !bubbleEl.hidden) hush();

  place();
  sendHit();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------ speech + effects
let bubbleTimer = null;
// `actions`: [{label, act}] renders small buttons inside the bubble.
function say(text, { ms = 3800, small = "", alert = false, clickable = false, force = false, actions = null } = {}) {
  char && char.talk(Math.min(1600, 400 + text.length * 30));
  // Normally the open chat shows messages instead of a bubble, but an alert
  // (reminder / water / session) must show even while the chat is open.
  if (!chatEl.hidden && !alert && !force && !actions) return;
  clearTimeout(bubbleTimer);
  bubbleEl.textContent = "";
  const line = document.createElement("div");
  line.textContent = text;
  bubbleEl.appendChild(line);
  if (small) { const s = document.createElement("small"); s.textContent = small; bubbleEl.appendChild(s); }
  const hasBtns = actions && actions.length;
  if (hasBtns) {
    const row = document.createElement("div");
    row.className = "bub-actions";
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      b.addEventListener("click", (e) => { e.stopPropagation(); try { a.act(); } catch (_) {} hush(); if (peekMode) peekUntil = performance.now() + PEEK.quick; });
      row.appendChild(b);
    });
    bubbleEl.appendChild(row);
  }
  bubbleEl.classList.toggle("alert", alert);
  bubbleEl.classList.toggle("clickable", clickable || hasBtns);
  bubbleEl.hidden = false;
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(hush, ms);
  sendHit(true);
}
function hush() {
  bubbleEl.hidden = true;
  bubbleEl.classList.remove("clickable", "alert");
  sendHit(true);
}
// Clicking the bubble dismisses it only when it has no action buttons.
bubbleEl.addEventListener("click", () => { if (!bubbleEl.querySelector(".bub-actions")) { hush(); if (peekMode) peekUntil = performance.now() + PEEK.quick; } });

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
  // Peek mode: no wandering or dozing — rest tucked in the corner until a nudge.
  if (peekMode) { x = roamMax(); return; }
  await pause(400, mine);
  // If a drag left the pet outside its corner zone, amble back into it first.
  if (x < roamMin() - 2 || x > roamMax() + 2) {
    await walkTo(clamp(x, roamMin(), roamMax()), mine);
    setBreathe(true);
  }
  while (!stale(mine)) {
    if (shouldSleep()) { await doze(mine); continue; }
    const r = Math.random();
    if (cfg.pet.wander && r < 0.4) {
      // a step or two within the bottom-right zone
      const lo = roamMin(), hi = roamMax();
      const step = Math.min(Math.max(0, hi - lo), 1.2 * W);
      await walkTo(clamp(x + rand(-step, step), lo, hi), mine);
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
  $("chatClear").hidden = chatLog.children.length === 0;
  reflect();
  invoke("focus_pet").catch(() => {});
  setTimeout(() => chatInput.focus(), 30);
  sendHit(true);
}

function closeChat(resume = true) {
  chatEl.hidden = true;
  chatInput.blur();
  if (peekMode) peekUntil = performance.now() + 500; // slide away shortly after
  sendHit(true);
  if (resume) brain();
}

function clearChat() {
  chatLog.textContent = "";
  $("chatClear").hidden = true;
  chatInput.focus();
  sendHit(true);
}
$("chatClear").addEventListener("click", (e) => { e.stopPropagation(); clearChat(); });

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
  $("chatClear").hidden = false;
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

let sessionPaused = false;
let sessionActive = false;
listen("tick", ({ payload: p }) => {
  bedtime = !!p.bedtime;
  sessionPaused = !!p.sessionPaused;
  sessionActive = p.sessionLeft != null;
  if (sessionActive) {
    badgeEl.textContent = (sessionPaused ? "❚❚ " : "") + fmt(p.sessionLeft);
    badgeEl.classList.toggle("paused", sessionPaused);
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
});
// Click the countdown badge for quick focus controls.
badgeEl.style.pointerEvents = "auto";
badgeEl.style.cursor = "pointer";
badgeEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!sessionActive) return;
  say(sessionPaused ? "Focus paused" : "Focus running", {
    ms: 0, alert: true,
    actions: sessionPaused
      ? [
          { label: "Resume", act: () => invoke("resume_session") },
          { label: "End", act: () => invoke("stop_session") },
        ]
      : [
          { label: "Pause", act: () => invoke("pause_session") },
          { label: "End", act: () => invoke("stop_session") },
        ],
  });
});
listen("session-started", ({ payload: m }) => {
  touched();
  peekFor(5000);
  say(`Focus time — ${m} min. I'll keep watch.`);
});
listen("session-stopped", () => { badgeEl.hidden = true; });
listen("session-busy", () => {
  touched();
  peekFor(PEEK.nudge);
  say("You're already in a focus session.", {
    ms: 0, alert: true,
    actions: [
      { label: "Keep going", act: () => {} },
      { label: "End it", act: () => invoke("stop_session") },
    ],
  });
});
listen("session-paused", () => { peekFor(3000); say("Focus paused.", { ms: 2500 }); });
listen("session-resumed", () => { peekFor(2500); say("Back to it.", { ms: 2000 }); });
listen("session-done", () => {
  badgeEl.hidden = true;
  if (cfg.session.chime) chime("done");
  forcedSleep = false;
  touched();
  pat();
  setTimeout(() => { peekFor(PEEK.long); say("Session done! Take a short break.", {
    ms: 0, alert: true,
    actions: [
      { label: "Another " + (cfg.session.minutes || 25), act: () => invoke("start_session", {}) },
      { label: "Done", act: () => {} },
    ],
  }); }, 650);
});
listen("reminder", ({ payload: r }) => {
  chime("remind");
  forcedSleep = false;
  touched();
  peekFor(PEEK.nudge);
  brain();
  say(r.text, {
    ms: 0, alert: true, small: "Reminder",
    actions: [
      { label: "Snooze 10m", act: () => invoke("ask", { text: `/remind ${r.text} in 10 min` }) },
      { label: "Dismiss", act: () => {} },
    ],
  });
});
listen("water", () => {
  touched();
  peekFor(PEEK.nudge);
  char && char.wave(1);
  say("Time for a sip of water 💧", {
    ms: 0, alert: true,
    actions: [
      { label: "Done", act: () => {} },
      { label: "Snooze 10m", act: () => invoke("snooze_water", { minutes: 10 }) },
      { label: "Turn off", act: () => invoke("ask", { text: "/water off" }) },
    ],
  });
});
listen("routine", ({ payload: r }) => {
  chime("remind");
  forcedSleep = false;
  touched();
  peekFor(PEEK.nudge);
  brain();
  say(r.label, {
    ms: 0, alert: true, small: "Routine",
    actions: [
      { label: "Done", act: () => {} },
      { label: "Snooze 10m", act: () => invoke("snooze_routine", { id: r.id, minutes: 10 }) },
      { label: "Stop", act: () => invoke("set_routine_enabled", { id: r.id, enabled: false }) },
    ],
  });
});
listen("bedtime", () => {
  peekFor(6500);
  say("It's getting late. Goodnight!", { ms: 6000 });
});
listen("cursor", ({ payload }) => onCursor(payload));
listen("open-chat", () => openChat());
listen("config-changed", ({ payload }) => {
  cfg = payload;
  const wasPeek = peekMode;
  peekMode = !!cfg.pet.peek;
  applySize();
  if (peekMode !== wasPeek) { peekUntil = 0; brain(); } // re-park or resume roaming
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
// Start grounded at centre so the pet is exactly where you'd look, just
// above the Dock. (The drop-in entrance is nice but can park it mid-screen
// if the window is still resizing to the work area on first paint.)
x = roamMax(); // start tucked in the bottom-right
lift = 0;
mode = "idle";
setBreathe(true);
place();
log("pet mounted", { W, H, x, innerW: window.innerWidth, innerH: window.innerHeight });
invoke("pet_ready", { w: window.innerWidth, h: window.innerHeight }).catch(() => {});
requestAnimationFrame(frame);
// In peek mode the pet stays tucked away until a nudge; no launch greeting.
if (!peekMode) {
  setTimeout(() => {
    const name = (cfg.pet.userName || "").trim();
    say(name ? `Hi ${name}! Double-click me to chat.` : "Hi! Double-click me to chat.", { ms: 5000 });
  }, 900);
}
