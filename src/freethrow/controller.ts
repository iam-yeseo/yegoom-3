import { FRAME_DT, simulateShot, type ShotFrame, type ShotInput, type ShotResult } from "../../shared/freethrow-physics";
import { reduced } from "../motion";
import { GESTURE, holdOffset, readGesture, type GestureOutcome, type GesturePoint } from "./gesture";
import { BALL_REST_RADIUS, FreeThrowRenderer, REST, STAGE, restScene, type Scene } from "./render";
import type { FreeThrowSound } from "./sound";

export type ThrowMode = "idle" | "holding" | "flying";
export interface ThrowCallbacks {
  /** The shot has left the hand (input already decided). */
  onThrow?(input: ShotInput): void;
  /** The outcome is visible: the ball went through or hit the floor. */
  onResult(result: ShotResult): void;
  /** The finger let go without a real flick, so the ball went back. */
  onCancel?(reason: Exclude<GestureOutcome, { shot: ShotInput }>["reason"]): void;
  onMode?(mode: ThrowMode): void;
}
const RETURN_MS = 260;
const RELEASE_BLEND = 0.16;
const FADE_IN = 0.28;
const FADE_BELOW = 1.05;

/** Owns the canvas: pointer input, the flight playback and the draw loop.
 * The loop only runs while something moves; a resting ball draws once. */
export class FreeThrowController {
  private renderer: FreeThrowRenderer;
  private scene: Scene = restScene();
  private mode: ThrowMode = "idle";
  private pointer: number | null = null;
  private points: GesturePoint[] = [];
  private grabbed: GesturePoint | null = null;
  private flight: { result: ShotResult; start: number; release: { x: number; y: number }; decideAt: number; event: number; reported: boolean } | null = null;
  private returning: { from: { x: number; y: number }; start: number } | null = null;
  private fadeStart: number | null = null;
  private effectsUntil = 0;
  private rimAt = -1;
  private netAt = -1;
  private frame = 0;
  private observer: ResizeObserver | null = null;
  private enabled = true;

  constructor(private canvas: HTMLCanvasElement, private sound: FreeThrowSound, private callbacks: ThrowCallbacks) {
    this.renderer = new FreeThrowRenderer(canvas);
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.cancel);
    canvas.addEventListener("lostpointercapture", this.cancel);
    canvas.addEventListener("contextmenu", this.prevent);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => { if (this.renderer.resize()) this.paint(); });
      this.observer.observe(canvas);
    }
    this.renderer.resize();
    this.paint();
  }
  get current() { return this.mode; }
  /** Stops new throws (a dialog is open, the page is hidden…). */
  setEnabled(value: boolean) { this.enabled = value; if (!value) this.cancel(); }
  /** Throws without a gesture: used by tests and the keyboard. */
  shoot(input: ShotInput) {
    if (this.mode !== "idle" || !this.enabled) return;
    this.launch(input, { x: 0, y: 0 });
  }
  destroy() {
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.cancel);
    this.canvas.removeEventListener("lostpointercapture", this.cancel);
    this.canvas.removeEventListener("contextmenu", this.prevent);
  }

  private setMode(mode: ThrowMode) { if (this.mode !== mode) { this.mode = mode; this.callbacks.onMode?.(mode); } }
  private prevent = (event: Event) => event.preventDefault();
  /** Client coordinates → stage units (stage heights) and logical pixels. */
  private stagePoint(event: PointerEvent): GesturePoint {
    const rect = this.canvas.getBoundingClientRect();
    const height = rect.height || STAGE.height;
    return { x: (event.clientX - rect.left) / height, y: (event.clientY - rect.top) / height, t: event.timeStamp };
  }
  private toPixels(point: { x: number; y: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: point.x * (rect.height || STAGE.height) * STAGE.width / (rect.width || STAGE.width), y: point.y * STAGE.height };
  }
  private down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0 || this.mode !== "idle" || !this.enabled) return;
    const point = this.stagePoint(event), pixel = this.toPixels(point);
    // Only a touch on (or just around) the ball picks it up.
    if (Math.hypot(pixel.x - REST.x, pixel.y - REST.y) > BALL_REST_RADIUS * 1.8) return;
    event.preventDefault();
    // A ball still sliding back from a cancelled swipe can be grabbed again.
    this.returning = null; this.scene.offset = { x: 0, y: 0 };
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
    this.pointer = event.pointerId; this.grabbed = point; this.points = [point];
    this.sound.activate(); this.sound.grab();
    this.setMode("holding");
    this.loop();
  };
  private move = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) this.points.push(this.stagePoint(sample));
    const last = this.points[this.points.length - 1]!;
    while (this.points.length > 2 && last.t - this.points[0]!.t > GESTURE.keepMs) this.points.shift();
    this.scene.offset = this.heldOffset(last);
  };
  private heldOffset(point: GesturePoint) {
    const offset = holdOffset(this.grabbed!, point);
    return { x: offset.x * STAGE.height, y: offset.y * STAGE.height };
  }
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    this.points.push(this.stagePoint(event));
    this.pointer = null;
    const outcome = readGesture(this.points);
    if (!outcome.shot) { this.callbacks.onCancel?.(outcome.reason); this.giveBack(); return; }
    this.launch(outcome.shot, this.scene.offset);
  };
  private cancel = () => {
    if (this.mode !== "holding") return;
    this.pointer = null;
    this.giveBack();
  };
  private giveBack() {
    this.returning = { from: { ...this.scene.offset }, start: performance.now() };
    this.setMode("idle");
    this.loop();
  }
  private launch(input: ShotInput, release: { x: number; y: number }) {
    const result = simulateShot(input);
    const floor = result.events.find(event => event.type === "floor");
    const end = (result.frames.length - 1) * FRAME_DT;
    const decideAt = result.made ? result.madeAt! : floor?.t ?? end;
    this.flight = { result, start: performance.now(), release: { ...release }, decideAt, event: 0, reported: false };
    this.sound.activate(); this.sound.throw();
    this.callbacks.onThrow?.(result.input);
    this.setMode("flying");
    this.loop();
  }
  private loop() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    let moving = this.mode === "holding";
    if (this.returning) {
      const share = Math.min(1, (now - this.returning.start) / RETURN_MS), ease = 1 - (1 - share) ** 3;
      this.scene.offset = { x: this.returning.from.x * (1 - ease), y: this.returning.from.y * (1 - ease) };
      if (share >= 1) this.returning = null; else moving = true;
    }
    if (this.flight) moving = this.fly(now) || moving;
    if (this.fadeStart !== null) {
      const share = Math.min(1, (now - this.fadeStart) / 1000 / FADE_IN);
      this.scene.alpha = share;
      if (share >= 1) this.fadeStart = null; else moving = true;
    }
    const calm = reduced();
    this.scene.rimShake = calm || this.rimAt < 0 ? 0 : Math.max(0, 1 - (now - this.rimAt) / 350);
    this.scene.netAge = calm || this.netAt < 0 ? null : (now - this.netAt) / 1000;
    if (now < this.effectsUntil) moving = true;
    this.paint();
    if (moving) this.frame = requestAnimationFrame(this.tick);
  };
  /** Advances the recorded flight; returns whether it is still playing. */
  private fly(now: number): boolean {
    const flight = this.flight!, { result } = flight;
    const t = (now - flight.start) / 1000;
    const index = t / FRAME_DT, frames = result.frames;
    const base = Math.min(frames.length - 1, Math.floor(index)), next = Math.min(frames.length - 1, base + 1), share = Math.min(1, index - base);
    const a = frames[base]!, b = frames[next]!;
    const ball: ShotFrame = { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share, z: a.z + (b.z - a.z) * share };
    const blend = Math.max(0, 1 - t / RELEASE_BLEND);
    this.scene.ball = ball;
    this.scene.offset = { x: flight.release.x * blend, y: flight.release.y * blend };
    this.scene.spin = -t * 9;
    while (flight.event < result.events.length && result.events[flight.event]!.t <= t) {
      const event = result.events[flight.event++]!;
      if (event.type === "rim") { this.sound.rim(); this.rimAt = now; this.effectsUntil = Math.max(this.effectsUntil, now + 400); }
      else if (event.type === "board") this.sound.board();
      else if (event.type === "net") { this.sound.net(); this.netAt = now; this.effectsUntil = Math.max(this.effectsUntil, now + 1300); }
      else this.sound.floor();
    }
    // The stylised court has no real floor under the hoop, so a falling ball
    // fades out below hand height instead of bouncing in the painted lane.
    this.scene.alpha = t < 0.3 ? 1 : Math.max(0, Math.min(1, (ball.y - FADE_BELOW) / 0.7));
    if (!flight.reported && t >= flight.decideAt) { flight.reported = true; this.callbacks.onResult(result); }
    if (index < frames.length - 1 && (this.scene.alpha > 0 || !flight.reported)) return true;
    if (!flight.reported) { flight.reported = true; this.callbacks.onResult(result); }
    // The next ball appears in the hand.
    this.flight = null;
    this.scene = { ...restScene(), alpha: 0 };
    this.fadeStart = now;
    this.setMode("idle");
    return true;
  }
  private paint() { this.renderer.draw(this.scene); }
}
