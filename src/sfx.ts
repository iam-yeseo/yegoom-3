/** Recorded UI and slot machine sound effects (public/sfx, made with ElevenLabs).
 * One AudioContext for the whole app, created on the first press so browsers
 * allow it. Files are fetched and decoded on first use, never on page load.
 * 내 정보 › 효과음 turns them off on this device. */
export type SfxName =
  | "tap" | "sheet-open" | "sheet-close" | "notify" | "coin" | "coin-big" | "purchase" | "error"
  | "slot-lever" | "slot-spin" | "slot-stop" | "slot-jackpot" | "slot-lose";

/** Per-file level after peak normalisation: frequent sounds stay quiet. */
const LEVEL: Record<SfxName, number> = {
  tap: .32, "sheet-open": .22, "sheet-close": .2, notify: .45, coin: .5, "coin-big": .5, purchase: .45, error: .5,
  "slot-lever": .55, "slot-spin": .3, "slot-stop": .55, "slot-jackpot": .6, "slot-lose": .5,
};
const KEY = "yegoom3:sfx";
/** Gold gains from this much play the bigger coin pour. */
export const BIG_GOLD = 500;

export function readSfxEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}
let enabled = readSfxEnabled();
export function saveSfxEnabled(value: boolean) {
  enabled = value;
  if (!value) stopLoops();
  try { localStorage.setItem(KEY, value ? "on" : "off"); } catch { /* Applies for this visit without storage. */ }
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<SfxName, Promise<AudioBuffer | null>>();
const loops = new Set<AudioBufferSourceNode>();

function context(): AudioContext | null {
  try {
    if (!ctx) {
      const Context = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return null;
      ctx = new Context();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}
function load(name: SfxName): Promise<AudioBuffer | null> {
  let buffer = buffers.get(name);
  if (!buffer) {
    const ac = context();
    buffer = !ac ? Promise.resolve(null) : fetch(`/sfx/${name}.mp3`)
      .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))))
      .then(data => ac.decodeAudioData(data))
      .catch(() => { buffers.delete(name); return null; });
    buffers.set(name, buffer);
  }
  return buffer;
}
function stopLoops() {
  for (const source of loops) try { source.stop(); } catch { /* Already stopped. */ }
  loops.clear();
}

interface PlayOptions {
  /** Extra gain on top of the file's level. */
  gain?: number;
  /** Playback rate; below 1 is lower and slower. */
  rate?: number;
}
/** Plays once. Silently does nothing when off, unsupported, or not yet unlocked. */
export function playSfx(name: SfxName, { gain = 1, rate = 1 }: PlayOptions = {}) {
  if (!enabled) return;
  void start(name, gain, rate, false);
}
/** Starts a seamless loop; the returned function stops it (safe to call twice). */
export function loopSfx(name: SfxName, options: PlayOptions = {}): { stop: () => void; setRate: (rate: number) => void } {
  let source: AudioBufferSourceNode | null = null;
  let stopped = !enabled;
  let rate = options.rate ?? 1;
  if (!stopped) void start(name, options.gain ?? 1, rate, true).then(node => {
    if (!node) return;
    if (stopped) { try { node.stop(); } catch { /* Already stopped. */ } return; }
    source = node;
    loops.add(node);
  });
  return {
    stop() {
      stopped = true;
      if (!source) return;
      try { source.stop(); } catch { /* Already stopped. */ }
      loops.delete(source);
      source = null;
    },
    setRate(next) {
      rate = next;
      if (source && ctx) source.playbackRate.setTargetAtTime(next, ctx.currentTime, .08);
    },
  };
}
async function start(name: SfxName, gain: number, rate: number, loop: boolean) {
  context();
  const buffer = await load(name);
  const ac = ctx;
  if (!buffer || !ac || !master || !enabled) return null;
  const source = ac.createBufferSource();
  const amp = ac.createGain();
  source.buffer = buffer;
  source.loop = loop;
  source.playbackRate.value = rate;
  amp.gain.value = LEVEL[name] * gain;
  source.connect(amp).connect(master);
  source.onended = () => { source.disconnect(); amp.disconnect(); loops.delete(source); };
  source.start();
  return source;
}

/** A soft tap for every button press; buttons in a game with its own sounds opt out
 * with [data-nosfx] on the button or any ancestor. */
export function installTapSound() {
  // Some browsers (iOS Safari) only unlock audio on a finished gesture, so
  // every release also resumes the shared context. Nothing is created while off.
  const unlock = () => { if (enabled) context(); };
  document.addEventListener("pointerup", unlock, { capture: true, passive: true });
  document.addEventListener("keydown", unlock, { capture: true, passive: true });
  document.addEventListener("pointerdown", event => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const button = (event.target as Element | null)?.closest<HTMLElement>("button,[data-press]");
    if (!button || (button as HTMLButtonElement).disabled || button.closest("[data-nosfx]")) return;
    playSfx("tap");
  }, { capture: true, passive: true });
}
