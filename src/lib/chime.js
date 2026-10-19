// A soft two-note chime, synthesised — no audio files to ship.
let ctx = null;

export function chime(kind = "done") {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === "remind" ? [784, 988, 784] : [659, 988];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.18;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
  } catch (_) {
    /* sound is a nicety; never fail on it */
  }
}
