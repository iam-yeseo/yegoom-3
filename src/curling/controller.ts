import { AIM_RATIO, FRAME_DT, inHouse, startThrow, type StoneInput, type StonePosition, type ThrowResult, type ThrowRun } from "../../shared/curling-physics";
import type { ArcadeSound } from "../arcade/sound";
import { readGesture, type GestureConfig, type GesturePoint } from "../freethrow/gesture";
import { CurlingRenderer, RELEASE, STAGE, STONE_RADIUS, toScreen, type Scene } from "./render";

/** The swipe that pushes a stone: the same reading as a free throw, power only
 * (the direction is chosen before the push). */
export const CURLING_GESTURE: GestureConfig = { windowMs: 110, minRise: 0.07, minSpeed: 0.5, fullPowerSpeed: 4.4, fullAimSlope: 0.8, stallMs: 60 };
const KEEP_MS = 400;
const PULL = { down: 0.11, up: 0.04 };
/** A touch this near the waiting stone picks it up; anywhere else turns the aim. */
const GRAB_RADIUS = STONE_RADIUS * 2.6;
/** Sweeping: rubbing the ice while the stone slides. The finger has to keep
 * moving: this much travel (logical pixels) within `windowMs` counts as
 * brushing, and it lasts `holdMs` past the last such moment. */
const SWEEP_TOUCH = { travel: 14, windowMs: 140, holdMs: 110 };
/** If the page stalls, the slide resumes from where it was rather than jumping ahead. */
const MAX_CATCH_UP = 8;

export type SheetMode = "ready" | "holding" | "sliding" | "over";
export interface SheetCallbacks {
  onMode?(mode: SheetMode): void;
  onAim?(aim: number): void;
  /** The stone has left the hand. */
  onThrow?(input: StoneInput): void;
  /** The player started or stopped brushing the ice. */
  onSweep?(sweeping: boolean): void;
  /** Everything has stopped. `result.input` is the throw as played, sweeping included. `sheet` is what is left in play. */
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
  private slide: { run: ThrowRun; start: number } | null = null;
  /** The finger rubbing the ice during a slide: where it has been lately. */
  private brush: { pointer: number; trail: { x: number; y: number; t: number }[]; until: number } | null = null;
  private sweeping = false;
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
  /** Brushes (or stops brushing) without a finger: used by tests and the keyboard. */
  sweep(on: boolean) { this.brush = on ? { pointer: -1, trail: [], until: Infinity } : null; }
  /** A new end: the sheet is swept clean. */
  reset() {
    this.sheet = []; this.thrown = 0; this.slide = null; this.offset = 0; this.brush = null; this.setSweeping(false);
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
  private setSweeping(value: boolean) { if (this.sweeping !== value) { this.sweeping = value; this.callbacks.onSweep?.(value); } }
  /** Whether the finger is rubbing right now: recent travel, not just resting on the ice. */
  private brushing(now: number): boolean {
    const brush = this.brush;
    if (!brush || !this.enabled) return false;
    if (brush.pointer === -1) return true;
    return now < brush.until;
  }
  private rub(event: PointerEvent) {
    const brush = this.brush!, pixel = this.toPixels(this.stagePoint(event)), now = performance.now();
    brush.trail.push({ x: pixel.x, y: pixel.y, t: now });
    while (brush.trail.length > 1 && now - brush.trail[0]!.t > SWEEP_TOUCH.windowMs) brush.trail.shift();
    let travel = 0;
    for (let i = 1; i < brush.trail.length; i++) travel += Math.hypot(brush.trail[i]!.x - brush.trail[i - 1]!.x, brush.trail[i]!.y - brush.trail[i - 1]!.y);
    if (travel >= SWEEP_TOUCH.travel) brush.until = now + SWEEP_TOUCH.holdMs;
  }
  private down = (event: PointerEvent) => {
    if (this.mode === "sliding" && event.isPrimary && event.button <= 0 && this.enabled) {
      // Anywhere on the ice: the finger becomes the broom.
      event.preventDefault();
      this.rect = null;
      try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
      this.brush = { pointer: event.pointerId, trail: [], until: 0 };
      this.rub(event);
      return;
    }
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
    if (this.brush && event.pointerId === this.brush.pointer) { this.rub(event); return; }
    if (event.pointerId === this.aiming) { this.aimToward(this.toPixels(this.stagePoint(event))); return; }
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) this.points.push(this.stagePoint(sample));
    const last = this.points[this.points.length - 1]!;
    while (this.points.length > 2 && last.t - this.points[0]!.t > KEEP_MS) this.points.shift();
    this.offset = Math.max(-PULL.up, Math.min(PULL.down, last.y - this.grabbed!.y)) * STAGE.height;
  };
  private up = (event: PointerEvent) => {
    if (this.brush && event.pointerId === this.brush.pointer) { this.brush = null; return; }
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
    if (this.brush && this.brush.pointer !== -1) this.brush = null;
    if (this.mode !== "holding") return;
    this.pointer = null; this.offset = 0;
    this.setMode("ready"); this.paint();
  };
  private launch(input: StoneInput) {
    this.slide = { run: startThrow(this.sheet, input, this.thrown), start: performance.now() };
    this.offset = 0; this.brush = null;
    this.sound.activate(); this.sound.noise(.5, .05, 500, "lowpass");
    this.callbacks.onThrow?.(input);
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
  private lastSwish = 0;
  /** Plays the slide on in real time, one physics frame at a time, brushing
   * whenever the finger is rubbing; returns whether it is still going. */
  private advance(now: number): boolean {
    const slide = this.slide!, { run } = slide;
    let due = Math.floor(Math.max(0, now - slide.start) / (FRAME_DT * 1000)) - run.frame;
    if (due > MAX_CATCH_UP) { slide.start = now - (run.frame + 1) * FRAME_DT * 1000; due = 1; }
    for (; due > 0 && !run.done; due--) {
      const brushing = this.brushing(now) && !!run.sliding();
      this.setSweeping(brushing);
      if (brushing && now - this.lastSwish > 130) { this.lastSwish = now; this.sound.noise(.12, .05, 2600, "highpass"); }
      for (const event of run.advance(brushing)) {
        if (event.type === "hit") { this.sound.tone(520, { duration: .09, type: "square", gain: .04, to: 380 }); this.sound.noise(.05, .1, 1800); this.sound.vibrate(16); }
        else this.sound.tone(140, { duration: .12, type: "sine", gain: .06, to: 90 });
      }
    }
    if (!run.done) return true;
    const result = run.result();
    this.slide = null; this.brush = null; this.setSweeping(false);
    this.sheet = result.after; this.thrown++;
    this.setMode(this.thrown >= this.stones ? "over" : "ready");
    this.callbacks.onResult(result, this.sheet);
    return false;
  }
  private paint() {
    const waiting = this.mode === "ready" || this.mode === "holding";
    const brush = this.sweeping && this.brush ? this.brush.trail[this.brush.trail.length - 1] : null;
    const sliding = this.sweeping ? this.slide?.run.sliding() : null;
    const scene: Scene = {
      stones: this.slide?.run.stones() ?? this.sheet, aim: this.aim,
      sweep: this.sweeping ? { at: brush ? { x: brush.x, y: brush.y } : sliding ? { x: toScreen(sliding.x, sliding.y).x, y: toScreen(sliding.x, sliding.y).y - STONE_RADIUS * 2.2 } : null, phase: performance.now() } : null,
      ready: waiting ? { id: this.thrown, offset: this.offset, held: this.mode === "holding" } : null,
      latest: this.slide ? this.thrown : this.thrown ? this.thrown - 1 : null,
    };
    this.renderer.draw(scene);
  }
}
/** Stones of a sheet that lie in the house. */
export const houseCount = (sheet: readonly StonePosition[]) => sheet.filter(inHouse).length;
