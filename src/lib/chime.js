// A soft two-note chime, synthesised — no audio files to ship.
//
// Each chime gets its own AudioContext and closes it when the notes end. An
// open AudioContext keeps the audio hardware running, and coreaudiod then
// blocks idle sleep for as long as it stays open — which drained a laptop
// overnight before this was fixed.

export function chime(kind = "done") {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === "remind" ? [784, 988, 784] : [659, 988];
    let last = null;
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
      last = o;
    });
    last.onended = () => ctx.close().catch(() => {});
    setTimeout(() => ctx.state !== "closed" && ctx.close().catch(() => {}), 3000); // in case onended never fires
  } catch (_) {
    /* sound is a nicety; never fail on it */
  }
}
