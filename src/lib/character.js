// The drop-in character engine.
//
// Any SVG works: the whole drawing breathes, walks, hops, dangles and
// sleeps. Parts are optional extras — give a group one of these ids (or a
// matching data-part="…") and it gets its own motion:
//
//   eyes | eye-left | eye-right   blink, squint while sleeping
//   pupils (or class="pupil")     follow the mouse pointer
//   mouth                         moves while talking
//   arm-left | arm-right          swing while walking, wave hello
//   antenna | tail | ears         lazy sway
//   face | head                   tilt
//
// data-origin="x% y%" on a part sets its pivot (e.g. a shoulder).
// Everything here is CSS transforms on the SVG groups — no path morphing,
// so it never needs the artwork split into matching shapes.

const PARTS = {
  eyes: ["eyes"],
  eyeLeft: ["eye-left"],
  eyeRight: ["eye-right"],
  mouth: ["mouth"],
  armLeft: ["arm-left"],
  armRight: ["arm-right"],
  sway: ["antenna", "tail", "ears"],
  face: ["face", "head"],
};

const DEFAULT_ORIGIN = {
  eyes: "50% 50%", eyeLeft: "50% 50%", eyeRight: "50% 50%",
  mouth: "50% 0%", armLeft: "80% 10%", armRight: "20% 10%",
  sway: "50% 100%", face: "50% 80%", pupil: "50% 50%",
};

const BLOCKED_TAGS = ["script", "foreignObject", "iframe", "embed", "object", "audio", "video", "set", "handler", "listener"];

/**
 * Does a mounted character actually draw something? False when its shapes are
 * empty, lie entirely outside the viewBox, or an embedded picture won't decode
 * — any of which would otherwise leave an invisible pet.
 */
export async function drawsSomething(svg) {
  let b;
  try { b = svg.getBBox(); } catch (_) { return false; }
  const vb = svg.viewBox.baseVal;
  const w = Math.min(b.x + b.width, vb.x + vb.width) - Math.max(b.x, vb.x);
  const h = Math.min(b.y + b.height, vb.y + vb.height) - Math.max(b.y, vb.y);
  if (!(w > 1 && h > 1)) return false;
  const pics = [...svg.querySelectorAll("image")].map((el) => el.getAttribute("href") || el.getAttribute("xlink:href") || "");
  const decoded = await Promise.all(pics.map((src) => new Promise((done) => {
    const i = new Image();
    i.onload = () => done(i.naturalWidth > 0);
    i.onerror = () => done(false);
    i.src = src;
  })));
  return decoded.every(Boolean);
}

/** Parse and defang an untrusted SVG string. Throws on non-SVG input. */
export function sanitizeSvg(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (doc.querySelector("parsererror") || svg.nodeName.toLowerCase() !== "svg") {
    throw new Error("That file isn't a valid SVG.");
  }
  BLOCKED_TAGS.forEach((t) => svg.querySelectorAll(t).forEach((n) => n.remove()));
  const walk = (el) => {
    [...el.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      const v = a.value.trim().toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      if ((name === "href" || name === "xlink:href") && !(v.startsWith("#") || v.startsWith("data:image/"))) {
        el.removeAttribute(a.name);
      }
      if (name === "style" && /url\(\s*['"]?(https?:|javascript:)/i.test(v)) el.removeAttribute(a.name);
    });
    [...el.children].forEach(walk);
  };
  walk(svg);
  return svg;
}

function findAll(svg, names) {
  const out = [];
  names.forEach((n) => svg.querySelectorAll(`#${n}, [data-part="${n}"]`).forEach((el) => out.push(el)));
  return [...new Set(out)];
}

function prep(el, key) {
  el.style.transformBox = "fill-box";
  el.style.transformOrigin = el.getAttribute("data-origin") || DEFAULT_ORIGIN[key] || "50% 50%";
  return el;
}

export class Character {
  constructor(host, svgText) {
    const svg = document.importNode(sanitizeSvg(svgText), true);
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(svg.getAttribute("width")) || 200;
      const h = parseFloat(svg.getAttribute("height")) || 200;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMax meet");
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.overflow = "visible";
    host.replaceChildren(svg);
    this.svg = svg;

    const vb = svg.viewBox.baseVal;
    this.aspect = vb && vb.height ? vb.width / vb.height : 1;

    this.parts = {};
    for (const [key, names] of Object.entries(PARTS)) {
      this.parts[key] = findAll(svg, names).map((el) => prep(el, key));
    }
    this.pupils = [...new Set([...svg.querySelectorAll(".pupil"), ...findAll(svg, ["pupils"])])].map((el) => prep(el, "pupil"));
    // blink the eyes group if present, otherwise each eye on its own
    this.blinkTargets = this.parts.eyes.length ? this.parts.eyes : [...this.parts.eyeLeft, ...this.parts.eyeRight];

    this.eyesClosed = false;
    this.anims = [];
    this._startSway();
  }

  /** Names of the optional parts found — shown in Settings. */
  detected() {
    const found = [];
    if (this.blinkTargets.length) found.push("eyes");
    if (this.pupils.length) found.push("pupils");
    if (this.parts.mouth.length) found.push("mouth");
    if (this.parts.armLeft.length) found.push("left arm");
    if (this.parts.armRight.length) found.push("right arm");
    if (this.parts.sway.length) found.push("antenna/tail");
    if (this.parts.face.length) found.push("face");
    return found;
  }

  destroy() {
    this.anims.forEach((a) => a.cancel());
    this.anims = [];
  }

  _startSway() {
    this.parts.sway.forEach((el, i) => {
      this.anims.push(el.animate(
        [{ transform: "rotate(-6deg)" }, { transform: "rotate(7deg)" }, { transform: "rotate(-6deg)" }],
        { duration: 2600 + i * 400, iterations: Infinity, easing: "ease-in-out" }
      ));
    });
  }

  blink() {
    if (this.eyesClosed) return;
    this.blinkTargets.forEach((el) => el.animate(
      [{ transform: "scaleY(1)" }, { transform: "scaleY(0.08)" }, { transform: "scaleY(1)" }],
      { duration: 160, easing: "ease-in-out" }
    ));
  }

  /** 1 = open, 0 = shut. Held until changed. */
  setEyes(open) {
    this.eyesClosed = open < 0.5;
    const s = Math.max(0.06, open);
    this.blinkTargets.forEach((el) => { el.style.transform = `scaleY(${s})`; });
  }

  /** Point the pupils toward (dx, dy), each clamped to -1..1. */
  look(dx, dy) {
    const k = 4.5; // user units
    const x = Math.max(-1, Math.min(1, dx)) * k;
    const y = Math.max(-1, Math.min(1, dy)) * k * 0.7;
    this.pupils.forEach((el) => { el.style.transform = `translate(${x}px, ${y}px)`; });
  }

  /** Walk phase in radians: arms swing opposite each other. */
  swing(phase, amount = 1) {
    const a = Math.sin(phase) * 16 * amount;
    this.parts.armLeft.forEach((el) => { el.style.transform = `rotate(${a}deg)`; });
    this.parts.armRight.forEach((el) => { el.style.transform = `rotate(${-a}deg)`; });
  }

  restArms() {
    [...this.parts.armLeft, ...this.parts.armRight].forEach((el) => { el.style.transform = ""; });
  }

  wave(times = 3) {
    const arm = this.parts.armRight[0] || this.parts.armLeft[0];
    if (!arm) return Promise.resolve();
    const dir = this.parts.armRight[0] ? -1 : 1;
    const frames = [{ transform: "rotate(0deg)" }];
    for (let i = 0; i < times; i++) {
      frames.push({ transform: `rotate(${dir * 150}deg)` }, { transform: `rotate(${dir * 110}deg)` });
    }
    frames.push({ transform: "rotate(0deg)" });
    return arm.animate(frames, { duration: 380 * times + 300, easing: "ease-in-out" }).finished.catch(() => {});
  }

  talk(ms = 1200) {
    this.parts.mouth.forEach((el) => el.animate(
      [{ transform: "scaleY(1)" }, { transform: "scaleY(1.9)" }, { transform: "scaleY(0.8)" }, { transform: "scaleY(1.6)" }, { transform: "scaleY(1)" }],
      { duration: Math.min(ms, 1600), easing: "ease-in-out" }
    ));
  }

  tilt(deg, ms = 500) {
    this.parts.face.forEach((el) => el.animate(
      [{ transform: "rotate(0deg)" }, { transform: `rotate(${deg}deg)` }, { transform: "rotate(0deg)" }],
      { duration: ms * 2, easing: "ease-in-out" }
    ));
  }
}
