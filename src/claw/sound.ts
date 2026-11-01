// Web Audio melodies, motors and haptics ported from yegoom's gatcha-sound.js.
// No audio context is created until the player interacts with the machine.
const STORAGE_KEY = "yegoom3:claw:muted";
const MELODY = [523, 659, 784, 659, 587, 698, 880, 698, 523, 659, 784, 1047, 988, 784, 659, 587];
interface Tone { at?: number; duration?: number; type?: OscillatorType; gain?: number; to?: number | null }

export function createSound() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let motor: { osc: OscillatorNode; amp: GainNode } | null = null;
  let music: ReturnType<typeof setTimeout> | null = null;
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
  function tone(freq: number, { at = 0, duration = .12, type = "square", gain = .05, to = null }: Tone = {}) {
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
  function noise(duration = .05, gain = .12) {
    const ac = audio();
    if (!ac || !master) return;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * duration), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const source = ac.createBufferSource(), amp = ac.createGain(), filter = ac.createBiquadFilter();
    filter.type = "bandpass"; filter.frequency.value = 1800;
    amp.gain.value = gain; source.buffer = buffer;
    source.connect(filter).connect(amp).connect(master);
    source.start();
  }
  function stopMotor() {
    if (!motor || !ctx) return;
    try { motor.amp.gain.setTargetAtTime(.0001, ctx.currentTime, .04); motor.osc.stop(ctx.currentTime + .2); } catch { /* Already stopped. */ }
    motor = null;
  }
  function stopMusic() { if (music !== null) clearTimeout(music); music = null; }
  return {
    get muted() { return muted; },
    activate: audio,
    setMuted(value: boolean) {
      muted = value;
      try { localStorage.setItem(STORAGE_KEY, value ? "1" : "0"); } catch { /* Storage is optional. */ }
      if (muted) { stopMotor(); stopMusic(); try { navigator.vibrate?.(0); } catch { /* Unsupported. */ } }
    },
    buzz(pattern: VibratePattern) { if (!muted && !disposed) buzz(pattern); },
    coin() { tone(1319, { duration: .08 }); tone(1760, { at: .07, duration: .22, gain: .045 }); },
    tick(urgent = false) { tone(urgent ? 1175 : 880, { duration: .05, gain: .03, type: "triangle" }); },
    clack() { noise(.05, .14); tone(180, { duration: .07, type: "triangle", gain: .08 }); },
    slip() { tone(740, { duration: .35, type: "sine", gain: .06, to: 220 }); },
    thud() { tone(110, { duration: .12, type: "sine", gain: .1, to: 60 }); },
    prize() { [784, 988, 1175, 1568].forEach((frequency, i) => tone(frequency, { at: i * .09, duration: .18, gain: .05 })); },
    sad() { [523, 494, 466, 440].forEach((frequency, i) => tone(frequency, { at: i * .16, duration: .2, type: "triangle", gain: .05 })); },
    motor(kind: "up" | "down" | "side" | null) {
      stopMotor();
      const ac = kind && audio();
      if (!ac || !master) return;
      const osc = ac.createOscillator(), amp = ac.createGain(), filter = ac.createBiquadFilter();
      osc.type = "sawtooth"; osc.frequency.value = kind === "up" ? 92 : kind === "down" ? 70 : 80;
      filter.type = "lowpass"; filter.frequency.value = 420;
      amp.gain.setValueAtTime(.0001, ac.currentTime); amp.gain.setTargetAtTime(.035, ac.currentTime, .05);
      osc.connect(filter).connect(amp).connect(master); osc.start(); motor = { osc, amp };
    },
    music(on: boolean) {
      stopMusic();
      if (!on || !audio()) return;
      let step = 0;
      const play = () => {
        tone(MELODY[step % MELODY.length], { duration: .16, type: "triangle", gain: .022 });
        if (step % 4 === 0) tone(MELODY[step % MELODY.length] / 4, { duration: .2, type: "square", gain: .012 });
        step++; music = setTimeout(play, 190);
      };
      play();
    },
    stop() { stopMotor(); stopMusic(); },
    dispose() { stopMotor(); stopMusic(); disposed = true; if (ctx) void ctx.close().catch(() => {}); },
  };
}
export function buzz(pattern: VibratePattern) { try { navigator.vibrate?.(pattern); } catch { /* Unsupported devices stay silent. */ } }
