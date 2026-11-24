// Curling and penalty: sound files from /sfx (docs/sfx.md 3.7) behind the game's own
// mute button, plus the older synthesized tones for the moments whose sound is still
// being chosen. The audio context starts only after the player touches the game.
import { createGameSfx } from "../sfx";

export function createArcadeSound(storageKey: string) {
  const sfx = createGameSfx(storageKey);
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let disposed = false;

  /** Builds the audio graph without starting it (opening the device takes a moment on phones). */
  function prepare() {
    if (sfx.muted || disposed) return null;
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
  const vibrate = (pattern: VibratePattern) => sfx.vibrate(pattern);
  return {
    get muted() { return sfx.muted; },
    prepare, activate() { audio(); sfx.activate(); }, tone, noise, vibrate,
    play: sfx.play, loop: sfx.loop, preload: sfx.preload,
    setMuted(value: boolean) { sfx.setMuted(value); },
    /** level 2 is the best result (a corner goal, a button stone): the big cheer. */
    cheer(level = 1) { sfx.play(level >= 2 ? "jackpot" : "coin", { delay: .1 }); },
    sad() { sfx.play("fail"); },
    dispose() { disposed = true; sfx.dispose(); if (ctx) void ctx.close().catch(() => {}); },
  };
}
export type ArcadeSound = ReturnType<typeof createArcadeSound>;
