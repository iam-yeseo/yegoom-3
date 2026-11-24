// Sound effects from files in /sfx (made with ElevenLabs, see docs/sfx.md).
// One AudioContext for the whole app; buffers are fetched once and decoded on demand.
// 내 정보 › 효과음 turns every sound off on this device; arcade games also keep
// their own mute button, and a sound plays only when both are on.

/** Playback gain per file. Files are all normalised to -16 LUFS, so the sounds heard
 * most often are turned down here (docs/sfx.md, 공통 규칙 5). */
export const SFX = {
  // Reference sounds (docs/sfx/reference)
  tap: .35, coin: .6, fail: .7, jackpot: .8,
  // Common
  "ui-toast": .45, "ui-sheet": .25, "ui-deny": .5,
  // Attendance
  "att-stamp": .7, "att-bonus": .75,
  // Shop
  "lot-pick": .5, "lot-match": .6,
  "spt-swipe": .6,
  "slt-lever": .65, "slt-spin": .35, "slt-stop": .55, "slt-tension": .7,
  "kuj-tear": .6, "kuj-lastone": .85,
  "tag-flip": .6, "tag-evolving": .45, "tag-vanish": .6,
  // Together games
  "bg-mark": .6, "bg-line": .65,
  "tl-flush": .65, "tl-nervous": .6, "tl-boom": .85,
  "prd-reveal": .7,
  "cm-send": .55, "cm-wrong": .4, "cm-hint": .6,
  // Arcade
  "clw-motor": .3, "clw-clack": .6, "clw-slip": .6, "clw-thud": .6, "clw-tick": .45,
  "ft-throw": .5, "ft-rim": .65, "ft-board": .6, "ft-floor": .5, "ft-net": .7,
  "sn-start": .65, "sn-drop": .5, "sn-hit": .7, "sn-rim": .6, "sn-thud": .55, "sn-pass": .5,
  "cur-grab": .5, "cur-slide": .5, "cur-brush": .35, "cur-stop": .5,
} as const;
export type SfxId = keyof typeof SFX;

/** Major pentatonic steps for sounds that climb one note at a time (lotto picks, reel stops). */
export const SFX_STEPS = [1, 1.122, 1.26, 1.498, 1.682] as const;
export const sfxStep = (index: number) => SFX_STEPS[Math.max(0, Math.min(SFX_STEPS.length - 1, index))];

const KEY = "yegoom3:sfx";
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== "off"; } catch { /* Storage is optional. */ }

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<SfxId, AudioBuffer>();
const loading = new Map<SfxId, Promise<AudioBuffer | null>>();
const loops = new Set<LoopHandle>();

function context() {
  if (ctx) return ctx;
  try {
    const Context = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    ctx = new Context();
    master = ctx.createGain(); master.gain.value = .9; master.connect(ctx.destination);
    return ctx;
  } catch { return null; }
}

function load(id: SfxId): Promise<AudioBuffer | null> {
  const ready = buffers.get(id);
  if (ready) return Promise.resolve(ready);
  const pending = loading.get(id);
  if (pending) return pending;
  const ac = context();
  if (!ac) return Promise.resolve(null);
  const promise = fetch(`/sfx/${id}.mp3`)
    .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))))
    .then(data => ac.decodeAudioData(data))
    .then(buffer => { buffers.set(id, buffer); return buffer; })
    // A sound that failed to load stays silent; the next request tries again.
    .catch(() => { loading.delete(id); return null; });
  loading.set(id, promise);
  return promise;
}

/** Starts fetching sounds a screen is about to use, so the first play is on time. */
export function preloadSfx(ids: readonly SfxId[]) {
  if (!enabled) return;
  for (const id of ids) void load(id);
}

/** Wakes the audio device. Browsers allow it only inside a user gesture. */
export function unlockSfx() {
  if (!enabled) return;
  const ac = context();
  if (ac?.state === "suspended") void ac.resume().catch(() => {});
}

export function sfxEnabled() { return enabled; }
export function setSfxEnabled(value: boolean) {
  enabled = value;
  try { localStorage.setItem(KEY, value ? "on" : "off"); } catch { /* Applies for this visit. */ }
  if (!value) for (const loop of [...loops]) loop.stop();
}

interface PlayOptions { rate?: number; gain?: number; delay?: number }
/** A sound requested before its file arrived still plays if it is only a little late. */
const LATE_MS = 250;

function start(id: SfxId, buffer: AudioBuffer, { rate = 1, gain = 1, delay = 0 }: PlayOptions, loop = false) {
  const ac = context();
  if (!ac || !master) return null;
  if (ac.state === "suspended") void ac.resume().catch(() => {});
  const source = ac.createBufferSource(), amp = ac.createGain();
  source.buffer = buffer; source.loop = loop; source.playbackRate.value = rate;
  amp.gain.value = SFX[id] * gain;
  source.connect(amp).connect(master);
  source.start(ac.currentTime + delay);
  return { source, amp };
}

/** Plays a sound once. Does nothing while 효과음 is off or the device has no audio. */
export function playSfx(id: SfxId, options: PlayOptions = {}) {
  if (!enabled) return;
  const buffer = buffers.get(id);
  if (buffer) { start(id, buffer, options); return; }
  const asked = performance.now();
  void load(id).then(loaded => { if (loaded && enabled && performance.now() - asked < LATE_MS) start(id, loaded, options); });
}

export interface LoopHandle { stop(): void; setRate(rate: number): void }
/** Plays a looping sound until `stop()`; it fades out instead of cutting off. */
export function loopSfx(id: SfxId, options: Omit<PlayOptions, "delay"> = {}): LoopHandle {
  let node: ReturnType<typeof start> = null;
  let stopped = false;
  let rate = options.rate ?? 1;
  const handle: LoopHandle = {
    stop() {
      stopped = true; loops.delete(handle);
      if (!node || !ctx) return;
      const { source, amp } = node; node = null;
      try { amp.gain.setTargetAtTime(0, ctx.currentTime, .04); source.stop(ctx.currentTime + .25); } catch { /* Already stopped. */ }
    },
    setRate(next) { rate = next; if (node && ctx) node.source.playbackRate.setTargetAtTime(next, ctx.currentTime, .05); },
  };
  if (!enabled) return handle;
  loops.add(handle);
  const begin = (buffer: AudioBuffer) => { if (!stopped && enabled) node = start(id, buffer, { ...options, rate }, true); };
  const buffer = buffers.get(id);
  if (buffer) begin(buffer); else void load(id).then(loaded => { if (loaded) begin(loaded); });
  return handle;
}

/** Arcade games: the shared sounds behind the game's own mute button (stored per game). */
export function createGameSfx(storageKey: string) {
  let muted = false;
  let disposed = false;
  const held = new Set<LoopHandle>();
  try { muted = localStorage.getItem(storageKey) === "1"; } catch { /* Storage is optional. */ }
  const on = () => !muted && !disposed && enabled;
  return {
    get muted() { return muted || !enabled; },
    setMuted(value: boolean) {
      muted = value;
      // Turning a game back on also turns 효과음 back on: the button promises sound.
      if (!value && !enabled) setSfxEnabled(true);
      try { localStorage.setItem(storageKey, value ? "1" : "0"); } catch { /* Storage is optional. */ }
      if (muted) for (const loop of [...held]) loop.stop();
    },
    play(id: SfxId, options?: PlayOptions) { if (on()) playSfx(id, options); },
    loop(id: SfxId, options?: Omit<PlayOptions, "delay">): LoopHandle {
      if (!on()) return { stop() {}, setRate() {} };
      const handle = loopSfx(id, options);
      held.add(handle);
      return { stop() { held.delete(handle); handle.stop(); }, setRate: rate => handle.setRate(rate) };
    },
    preload(ids: readonly SfxId[]) { if (on()) preloadSfx(ids); },
    activate() { if (on()) unlockSfx(); },
    vibrate(pattern: VibratePattern) { if (!muted && !disposed) try { navigator.vibrate?.(pattern); } catch { /* Unsupported. */ } },
    dispose() { disposed = true; for (const loop of [...held]) loop.stop(); held.clear(); },
  };
}
export type GameSfx = ReturnType<typeof createGameSfx>;

/** Arcade games play their own sounds for their buttons. */
const OWN_SOUNDS = /^#\/play\/(claw|freethrow|santa|curling|penalty)(\/|$)/;
let installed = false;
/** Wakes the audio device on the first touches and taps the main buttons of game and
 * shop screens (docs/sfx.md UI-01). Home, lists and the tab bar stay silent. */
export function installSfx() {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerdown", event => {
    unlockSfx();
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".shop-buy-bar button, .primary-button, [data-sfx-tap]");
    if (!button || button.disabled || button.closest("[data-sfx-quiet]")) return;
    const hash = location.hash;
    if (!button.closest(".shop-buy-bar") && !button.hasAttribute("data-sfx-tap")
      && (!/^#\/(play|shop)\//.test(hash) || OWN_SOUNDS.test(hash))) return;
    playSfx("tap");
  }, { capture: true, passive: true });
  document.addEventListener("keydown", unlockSfx, { capture: true, passive: true });
}
