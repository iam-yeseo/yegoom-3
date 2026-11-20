import { AIM_RATIO, FRAME_DT, inHouse, simulateThrow, type StoneInput, type StonePosition, type ThrowResult } from "../../shared/curling-physics";
import type { ArcadeSound } from "../arcade/sound";
import { readGesture, type GestureConfig, type GesturePoint } from "../freethrow/gesture";
import { CurlingRenderer, RELEASE, STAGE, STONE_RADIUS, type Scene } from "./render";

/** The swipe that pushes a stone: the same reading as a free throw, power only
 * (the direction is chosen before the push). */
export const CURLING_GESTURE: GestureConfig = { windowMs: 110, minRise: 0.07, minSpeed: 0.5, fullPowerSpeed: 4.4, fullAimSlope: 0.8, stallMs: 60 };
const KEEP_MS = 400;
const PULL = { down: 0.11, up: 0.04 };
/** A touch this near the waiting stone picks it up; anywhere else turns the aim. */
const GRAB_RADIUS = STONE_RADIUS * 2.6;

export type SheetMode = "ready" | "holding" | "sliding" | "over";
export interface SheetCallbacks {
  onMode?(mode: SheetMode): void;
  onAim?(aim: number): void;
  /** The stone has left the hand (input already decided). */
  onThrow?(input: StoneInput): void;
  /** Everything has stopped. `sheet` is what is left in play. */
  onResult(result: ThrowResult, sheet: StonePosition[]): void;
  /** The finger let go without a real push, so the stone stayed. */
  onCancel?(): void;
}

/** Owns the canvas: aiming, the push, the slide playback and the draw loop.
 * The loop only runs while something moves. */
export class CurlingController {
  private renderer: CurlingRenderer;
  private sheet: StonePosition[] = [];
  private thrown = 0;
  private aim = 0;
  private mode: SheetMode = "ready";
  private pointer: number | null = null;
  private aiming: number | null = null;
  private points: GesturePoint[] = [];
  private grabbed: GesturePoint | null = null;
  private offset = 0;
  private slide: { result: ThrowResult; start: number; event: number } | null = null;
  private frame = 0;
  private observer: ResizeObserver | null = null;
  private rect: DOMRect | null = null;
  private enabled = true;
  private destroyed = false;

  constructor(private canvas: HTMLCanvasElement, private sound: ArcadeSound, private callbacks: SheetCallbacks, private stones: number) {
    this.renderer = new CurlingRenderer(canvas, () => { if (!this.destroyed) this.paint(); });
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.cancel);
    canvas.addEventListener("lostpointercapture", this.cancel);
    canvas.addEventListener("contextmenu", this.prevent);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => { this.rect = null; if (this.renderer.resize()) this.paint(); });
      this.observer.observe(canvas);
    }
    this.renderer.resize();
    this.paint();
  }
  get current() { return this.mode; }
  /** Stops new throws (a dialog is open, the page is hidden…). */
  setEnabled(value: boolean) { this.enabled = value; if (!value) this.cancel(); }
  setAim(value: number) {
    const aim = Math.max(-100, Math.min(100, Math.round(value)));
    if (aim === this.aim) return;
    this.aim = aim; this.callbacks.onAim?.(aim);
    if (this.mode !== "sliding") this.paint();
  }
  /** Throws without a gesture: used by tests and the keyboard. */
  throwStone(power: number) {
    if (this.mode !== "ready" || !this.enabled) return;
    this.launch({ power, aim: this.aim });
  }
  /** A new end: the sheet is swept clean. */
  reset() {
    this.sheet = []; this.thrown = 0; this.slide = null; this.offset = 0;
    this.setMode("ready"); this.paint();
  }
  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.cancel);
    this.canvas.removeEventListener("lostpointercapture", this.cancel);
    this.canvas.removeEventListener("contextmenu", this.prevent);
  }

  private setMode(mode: SheetMode) { if (this.mode !== mode) { this.mode = mode; this.callbacks.onMode?.(mode); } }
  private prevent = (event: Event) => event.preventDefault();
  private bounds() { return this.rect ??= this.canvas.getBoundingClientRect(); }
  /** Client coordinates → stage units (stage heights), as the gesture reader expects. */
  private stagePoint(event: PointerEvent): GesturePoint {
    const rect = this.bounds(), height = rect.height || STAGE.height;
    return { x: (event.clientX - rect.left) / height, y: (event.clientY - rect.top) / height, t: event.timeStamp };
  }
  private toPixels(point: { x: number; y: number }) {
    const rect = this.bounds();
    return { x: point.x * (rect.height || STAGE.height) * STAGE.width / (rect.width || STAGE.width), y: point.y * STAGE.height };
  }
  /** The aim that points the dashed line at a touched spot on the ice. */
  private aimToward(pixel: { x: number; y: number }) {
    const ahead = Math.max(60, RELEASE.y - pixel.y);
    this.setAim((pixel.x - RELEASE.x) / ahead / AIM_RATIO * 100);
  }
  private down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0 || this.mode !== "ready" || !this.enabled) return;
    this.rect = null;
    const point = this.stagePoint(event), pixel = this.toPixels(point);
    event.preventDefault();
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
    this.sound.activate();
    if (Math.hypot(pixel.x - RELEASE.x, pixel.y - RELEASE.y) > GRAB_RADIUS) { this.aiming = event.pointerId; this.aimToward(pixel); return; }
    this.pointer = event.pointerId; this.grabbed = point; this.points = [point];
    this.sound.tone(300, { duration: .06, gain: .03 });
    this.setMode("holding");
    this.loop();
  };
  private move = (event: PointerEvent) => {
    if (event.pointerId === this.aiming) { this.aimToward(this.toPixels(this.stagePoint(event))); return; }
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) this.points.push(this.stagePoint(sample));
    const last = this.points[this.points.length - 1]!;
    while (this.points.length > 2 && last.t - this.points[0]!.t > KEEP_MS) this.points.shift();
    this.offset = Math.max(-PULL.up, Math.min(PULL.down, last.y - this.grabbed!.y)) * STAGE.height;
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId === this.aiming) { this.aiming = null; return; }
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    this.points.push(this.stagePoint(event));
    this.pointer = null;
    const outcome = readGesture(this.points, CURLING_GESTURE);
    if (!outcome.shot) { this.offset = 0; this.callbacks.onCancel?.(); this.setMode("ready"); this.paint(); return; }
    this.launch({ power: outcome.shot.power, aim: this.aim });
  };
  private cancel = () => {
    this.aiming = null;
    if (this.mode !== "holding") return;
    this.pointer = null; this.offset = 0;
    this.setMode("ready"); this.paint();
  };
  private launch(input: StoneInput) {
    const result = simulateThrow(this.sheet, input, this.thrown);
    this.slide = { result, start: performance.now(), event: 0 };
    this.offset = 0;
    this.sound.activate(); this.sound.noise(.5, .05, 500, "lowpass");
    this.callbacks.onThrow?.(result.input);
    this.setMode("sliding");
    this.loop();
  }
  private loop() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    let moving = this.mode === "holding";
    if (this.slide) moving = this.advance(now) || moving;
    this.paint();
    if (moving && !this.destroyed) this.frame = requestAnimationFrame(this.tick);
  };
  private live: StonePosition[] | null = null;
  /** Advances the recorded slide; returns whether it is still playing. */
  private advance(now: number): boolean {
    const slide = this.slide!, { result } = slide, frames = result.frames;
    const t = Math.max(0, (now - slide.start) / 1000), index = t / FRAME_DT;
    const base = Math.min(frames.length - 1, Math.floor(index)), next = Math.min(frames.length - 1, base + 1), share = Math.min(1, index - base);
    const later = frames[next]!.stones;
    // A stone taken off the sheet simply stops being drawn at its last frame.
    this.live = frames[base]!.stones.map(stone => {
      const to = later.find(candidate => candidate.id === stone.id);
      return to ? { id: stone.id, x: stone.x + (to.x - stone.x) * share, y: stone.y + (to.y - stone.y) * share } : stone;
    });
    while (slide.event < result.events.length && result.events[slide.event]!.t <= t) {
      const event = result.events[slide.event++]!;
      if (event.type === "hit") { this.sound.tone(520, { duration: .09, type: "square", gain: .04, to: 380 }); this.sound.noise(.05, .1, 1800); this.sound.vibrate(16); }
      else this.sound.tone(140, { duration: .12, type: "sine", gain: .06, to: 90 });
    }
    if (index < frames.length - 1) return true;
    this.slide = null; this.live = null;
    this.sheet = result.after; this.thrown++;
    this.setMode(this.thrown >= this.stones ? "over" : "ready");
    this.callbacks.onResult(result, this.sheet);
    return false;
  }
  private paint() {
    const waiting = this.mode === "ready" || this.mode === "holding";
    const scene: Scene = {
      stones: this.live ?? this.sheet, aim: this.aim,
      ready: waiting ? { id: this.thrown, offset: this.offset, held: this.mode === "holding" } : null,
      latest: this.slide ? this.thrown : this.thrown ? this.thrown - 1 : null,
    };
    this.renderer.draw(scene);
  }
}
/** Stones of a sheet that lie in the house. */
export const houseCount = (sheet: readonly StonePosition[]) => sheet.filter(inHouse).length;
