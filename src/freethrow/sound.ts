// Web Audio effects with no sound files, in the style of src/claw/sound.ts.
// The audio context starts only after the player touches the ball.
const STORAGE_KEY = "yegoom3:freethrow:muted";

export function createFreeThrowSound() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = false;
  let disposed = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === "1"; } catch { /* Storage is optional. */ }

  /** Builds the audio graph without starting it. Opening the audio device
   * takes a moment on phones; done at the first touch it made the ball stick
   * to the finger, so the court does it as it opens instead. */
  function prepare() {
    if (muted || disposed) return null;
    try {
      if (!ctx) {
        const Context = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Context) return null;
        ctx = new Context();
        master = ctx.createGain(); master.gain.value = .7; master.connect(ctx.destination);
      }
      return ctx;
    } catch { return null; }
  }
  function audio() {
    const ac = prepare();
    if (ac?.state === "suspended") void ac.resume().catch(() => {});
    return ac;
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
  function noise(duration: number, gain: number, frequency: number, type: BiquadFilterType = "bandpass") {
    const ac = audio();
    if (!ac || !master) return;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * duration), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const source = ac.createBufferSource(), amp = ac.createGain(), filter = ac.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency;
    amp.gain.value = gain; source.buffer = buffer;
    source.connect(filter).connect(amp).connect(master);
    source.start();
  }
  const vibrate = (pattern: VibratePattern) => { if (!muted && !disposed) try { navigator.vibrate?.(pattern); } catch { /* Unsupported. */ } };
  return {
    get muted() { return muted; },
    prepare,
    activate: audio,
    setMuted(value: boolean) {
      muted = value;
      try { localStorage.setItem(STORAGE_KEY, value ? "1" : "0"); } catch { /* Storage is optional. */ }
    },
    grab() { tone(330, { duration: .06, gain: .03 }); },
    throw() { noise(.16, .06, 900, "highpass"); },
    rim() { tone(620, { duration: .16, type: "square", gain: .035, to: 540 }); noise(.05, .1, 2600); vibrate(18); },
    board() { tone(150, { duration: .1, type: "sine", gain: .09, to: 90 }); noise(.04, .08, 700); },
    net() { noise(.28, .12, 3800, "highpass"); vibrate([12, 30, 12]); },
    floor() { tone(95, { duration: .09, type: "sine", gain: .08, to: 60 }); },
    cheer(streak: number) { [784, 988, 1175, 1568].slice(0, Math.min(4, 1 + Math.floor(streak / 2))).forEach((f, i) => tone(f, { at: .05 + i * .08, duration: .16, gain: .04 })); },
    sad() { [440, 415].forEach((f, i) => tone(f, { at: i * .14, duration: .18, gain: .035 })); },
    dispose() { disposed = true; if (ctx) void ctx.close().catch(() => {}); },
  };
}
export type FreeThrowSound = ReturnType<typeof createFreeThrowSound>;
