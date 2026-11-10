// Web Audio effects with no sound files, like src/freethrow/sound.ts.
// The audio context starts only after the player presses something.
const STORAGE_KEY = "yegoom3:santa:muted";

export function createSantaSound() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = false;
  let disposed = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* Storage is optional. */ }

  function audio() {
    if (muted || disposed) return null;
    try {
      if (!ctx) {
        const Context = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Context) return null;
        ctx = new Context();
        master = ctx.createGain(); master.gain.value = .7; master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      return ctx;
    } catch { return null; }
  }
  function tone(freq: number, { at = 0, duration = .12, type = "triangle" as OscillatorType, gain = .05, to = 0 } = {}) {
    const ac = audio();
    if (!ac || !master) return;
    const start = ac.currentTime + at, osc = ac.createOscillator(), amp = ac.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, start);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, start + duration);
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(amp).connect(master);
    osc.start(start); osc.stop(start + duration + .02);
  }
  /** A small sleigh-bell shake: a few bright detuned pings. */
  function bells(at: number, gain = .025) { [2093, 2637, 2349, 2794].forEach((f, i) => tone(f, { at: at + i * .035, duration: .18, type: "sine", gain })); }
  const vibrate = (pattern: VibratePattern) => { if (!muted && !disposed) try { navigator.vibrate?.(pattern); } catch { /* Unsupported. */ } };
  return {
    get muted() { return muted; },
    activate: audio,
    setMuted(value: boolean) {
      muted = value;
      try { localStorage.setItem(STORAGE_KEY, value ? "1" : "0"); } catch { /* Storage is optional. */ }
    },
    start() { bells(0); bells(.3); [523, 659, 784].forEach((f, i) => tone(f, { at: .62 + i * .1, duration: .16, gain: .04 })); },
    drop() { tone(880, { duration: .22, type: "sine", gain: .035, to: 330 }); },
    hit() { [784, 988, 1319].forEach((f, i) => tone(f, { at: i * .07, duration: .18, gain: .045 })); bells(.18, .018); vibrate([10, 30, 10]); },
    rim() { tone(260, { duration: .1, type: "square", gain: .03, to: 200 }); vibrate(18); },
    thud() { tone(110, { duration: .1, type: "sine", gain: .07, to: 70 }); },
    pass() { [392, 370].forEach((f, i) => tone(f, { at: i * .12, duration: .16, gain: .03 })); },
    finish(perfect: boolean) {
      const notes = perfect ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
      notes.forEach((f, i) => tone(f, { at: i * .09, duration: .2, gain: .045 }));
      bells(notes.length * .09);
    },
    dispose() { disposed = true; if (ctx) void ctx.close().catch(() => {}); },
  };
}
export type SantaSound = ReturnType<typeof createSantaSound>;
