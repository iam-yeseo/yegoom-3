import { GOAL, KICK, judgeKick, keeperAt, type Keeper, type KickInput, type KickResult } from "../../shared/penalty-engine";
import type { ArcadeSound } from "../arcade/sound";
import { holdOffset, readGesture, type GestureConfig, type GesturePoint } from "../freethrow/gesture";
import { BALL_GOAL_RADIUS, BALL_REST_RADIUS, GROUND, PenaltyRenderer, REST, STAGE, toScreen, type KeeperPose, type Scene } from "./render";

/** The swipe that strikes the ball: the same reading as a free throw. A swipe
 * straight at a post on screen is aimed at that post. */
export const PENALTY_GESTURE: GestureConfig = { windowMs: 110, minRise: 0.06, minSpeed: 0.5, fullPowerSpeed: 4.4, fullAimSlope: 0.55, stallMs: 60 };
const KEEP_MS = 400;
/** The walk-up before the whistle, and how long a result stays before the next kick. */
const INTRO_MS = 1100;
const AFTER_MS = 1500;
/** How far the gloves are from the middle of a diving keeper (metres). */
const DIVE_ARM = 1.1;

export type KickMode = "intro" | "aiming" | "holding" | "flying" | "after" | "over";
export interface KickCallbacks {
  onMode?(mode: KickMode): void;
  /** The ball has been struck, or the clock ran out (input already decided). */
  onKick?(input: KickInput): void;
  /** The outcome is visible. */
  onResult(result: KickResult, index: number): void;
  /** The finger let go without a real swipe, so the ball stayed. */
  onCancel?(): void;
}

/** Owns the canvas: the keeper's shuffle, the swipe, the flight and the draw
 * loop. `keepersFor(round)` gives each round's keepers; with `endless` a new
 * round starts after the last kick (practice). */
export class PenaltyController {
  private renderer: PenaltyRenderer;
  private keepers: Keeper[];
  private round = 0;
  private index = 0;
  private mode: KickMode = "intro";
  private phaseAt = performance.now();
  /** performance.now() of the whistle for the current kick. */
  private whistleAt = 0;
  private pointer: number | null = null;
  private points: GesturePoint[] = [];
  private grabbed: GesturePoint | null = null;
  private offset = { x: 0, y: 0 };
  private flight: { result: KickResult; start: number; reported: boolean; netAt: number | null } | null = null;
  private frame = 0;
  private observer: ResizeObserver | null = null;
  private rect: DOMRect | null = null;
  private enabled = true;
  private destroyed = false;

  constructor(private canvas: HTMLCanvasElement, private sound: ArcadeSound, private callbacks: KickCallbacks,
    private keepersFor: (round: number) => Keeper[], private endless = false) {
    this.renderer = new PenaltyRenderer(canvas);
    this.keepers = keepersFor(0);
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.cancel);
    canvas.addEventListener("lostpointercapture", this.cancel);
    canvas.addEventListener("contextmenu", this.prevent);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => { this.rect = null; this.renderer.resize(); });
      this.observer.observe(canvas);
    }
    this.renderer.resize();
    this.loop();
  }
  get current() { return this.mode; }
  /** Pauses the game (a dialog is open, the page is hidden…). A kick that was
   * waiting to be taken starts again from its whistle when play resumes. */
  setEnabled(value: boolean) {
    if (value === this.enabled) return;
    this.enabled = value;
    if (!value) { this.cancel(); cancelAnimationFrame(this.frame); return; }
    if (this.mode === "aiming" || this.mode === "intro") this.enter("intro");
    this.loop();
  }
  /** Kicks without a gesture: used by tests and the keyboard. */
  kick(power: number, aim: number) {
    if (this.mode !== "aiming" || !this.enabled) return;
    this.launch({ power, aim, t: this.elapsed() });
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

  private enter(mode: KickMode) {
    this.phaseAt = performance.now();
    if (mode === "intro") { this.flight = null; this.offset = { x: 0, y: 0 }; this.pointer = null; }
    if (this.mode !== mode) { this.mode = mode; this.callbacks.onMode?.(mode); }
  }
  private elapsed() { return Math.max(0, Math.min(KICK.windowMs, Math.round(performance.now() - this.whistleAt))); }
  private prevent = (event: Event) => event.preventDefault();
  private bounds() { return this.rect ??= this.canvas.getBoundingClientRect(); }
  private stagePoint(event: PointerEvent): GesturePoint {
    const rect = this.bounds(), height = rect.height || STAGE.height;
    return { x: (event.clientX - rect.left) / height, y: (event.clientY - rect.top) / height, t: event.timeStamp };
  }
  private toPixels(point: { x: number; y: number }) {
    const rect = this.bounds();
    return { x: point.x * (rect.height || STAGE.height) * STAGE.width / (rect.width || STAGE.width), y: point.y * STAGE.height };
  }
  private down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0 || this.mode !== "aiming" || !this.enabled) return;
    this.rect = null;
    const point = this.stagePoint(event), pixel = this.toPixels(point);
    // Only a touch on (or just around) the ball picks it up.
    if (Math.hypot(pixel.x - REST.x, pixel.y - REST.y) > BALL_REST_RADIUS * 2.4) return;
    event.preventDefault();
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
    this.pointer = event.pointerId; this.grabbed = point; this.points = [point];
    this.sound.activate(); this.sound.tone(330, { duration: .06, gain: .03 });
    this.setMode("holding");
  };
  private setMode(mode: KickMode) { if (this.mode !== mode) { this.mode = mode; this.callbacks.onMode?.(mode); } }
  private move = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    for (const sample of samples.length ? samples : [event]) this.points.push(this.stagePoint(sample));
    const last = this.points[this.points.length - 1]!;
    while (this.points.length > 2 && last.t - this.points[0]!.t > KEEP_MS) this.points.shift();
    const offset = holdOffset(this.grabbed!, last);
    this.offset = { x: offset.x * STAGE.height, y: offset.y * STAGE.height };
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer || this.mode !== "holding") return;
    this.points.push(this.stagePoint(event));
    this.pointer = null;
    const outcome = readGesture(this.points, PENALTY_GESTURE);
    if (!outcome.shot) { this.offset = { x: 0, y: 0 }; this.callbacks.onCancel?.(); this.setMode("aiming"); return; }
    this.launch({ power: outcome.shot.power, aim: outcome.shot.aim, t: this.elapsed() });
  };
  private cancel = () => {
    if (this.mode !== "holding") return;
    this.pointer = null; this.offset = { x: 0, y: 0 };
    this.setMode("aiming");
  };
  private launch(input: KickInput) {
    const result = judgeKick(this.keepers[this.index]!, input);
    this.flight = { result, start: performance.now(), reported: false, netAt: null };
    this.sound.activate();
    if (input.t >= 0) { this.sound.tone(120, { duration: .1, type: "sine", gain: .1, to: 70 }); this.sound.noise(.08, .1, 900); }
    this.callbacks.onKick?.(result.input);
    this.enter("flying");
  }
  private loop() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    if (this.destroyed || !this.enabled) return;
    const since = now - this.phaseAt;
    if (this.mode === "intro" && since >= INTRO_MS) {
      this.whistleAt = now; this.enter("aiming");
      this.sound.tone(2100, { duration: .22, type: "square", gain: .03 });
    } else if ((this.mode === "aiming" || this.mode === "holding") && now - this.whistleAt >= KICK.windowMs) {
      this.pointer = null; this.launch({ power: 0, aim: 0, t: -1 });
    } else if (this.mode === "after" && since >= AFTER_MS) this.next();
    this.renderer.draw(this.scene(now));
    if (this.mode !== "over") this.frame = requestAnimationFrame(this.tick);
  };
  private next() {
    if (this.index + 1 < this.keepers.length) { this.index++; this.enter("intro"); return; }
    if (!this.endless) { this.enter("over"); return; }
    this.round++; this.index = 0; this.keepers = this.keepersFor(this.round);
    this.enter("intro");
  }
  private standing(x: number, now: number): KeeperPose {
    return { x, lift: Math.max(0, Math.sin(now / 130)) * 0.05, lean: 0, stretch: 0.15 };
  }
  private scene(now: number): Scene {
    const keeper = this.keepers[this.index]!;
    const rest = { x: REST.x + this.offset.x, y: REST.y + this.offset.y, radius: BALL_REST_RADIUS, spin: 0, alpha: 1 };
    if (this.mode === "intro") {
      // The keeper walks to where their shuffle starts.
      const share = Math.min(1, (now - this.phaseAt) / INTRO_MS);
      return { keeper: this.standing(keeperAt(keeper, 0).x * share, now), ball: rest, ballBehind: false, clock: null, netAge: null, netAt: null };
    }
    if (this.mode === "aiming" || this.mode === "holding") {
      const t = now - this.whistleAt;
      return { keeper: this.standing(keeperAt(keeper, t).x, now), ball: rest, ballBehind: false, clock: Math.max(0, 1 - t / KICK.windowMs), netAge: null, netAt: null };
    }
    return this.flying(now);
  }
  /** The kick as it is played back: the ball to the goal line, the keeper's dive, then what the ball does next. */
  private flying(now: number): Scene {
    const flight = this.flight!, { result } = flight;
    const report = () => {
      if (flight.reported) return;
      flight.reported = true;
      if (result.made) { flight.netAt = now; this.sound.noise(.3, .12, 3600, "highpass"); this.sound.vibrate([12, 30, 12]); }
      else if (result.kind === "saved") { this.sound.tone(180, { duration: .12, type: "sine", gain: .09, to: 110 }); this.sound.vibrate(20); }
      else if (result.kind === "post") { this.sound.tone(640, { duration: .2, type: "square", gain: .04, to: 520 }); this.sound.vibrate(18); }
      this.callbacks.onResult(result, this.index);
      this.enter("after");
    };
    if (result.kind === "timeout") {
      report();
      return { keeper: this.standing(result.keeper.x, now), ball: { x: REST.x, y: REST.y, radius: BALL_REST_RADIUS, spin: 0, alpha: 1 }, ballBehind: false, clock: 0, netAge: null, netAt: null };
    }
    const t = Math.max(0, (now - flight.start) / 1000), share = Math.min(1, t / result.flight);
    const target = toScreen(result.target.x, result.target.y);
    // The dive: the keeper leaves for the ball as it is struck and arrives with it.
    const dive = result.keeper.dive, travel = dive.x - result.keeper.x, far = Math.min(1, Math.abs(travel) / 1.4);
    const eased = 1 - (1 - share) ** 2;
    // Up to meet the ball as it arrives, then back down to the grass.
    const u = t / result.flight, air = u < 1 ? Math.sin(Math.PI / 2 * u) : Math.max(0, 1 - (u - 1) * 2.2);
    const pose: KeeperPose = {
      // A keeper at full stretch reaches the ball with the gloves, not the belly: the body stops short of it.
      x: result.keeper.x + (travel - Math.sign(travel) * far * Math.min(Math.abs(travel), DIVE_ARM)) * eased,
      lift: air * (far * Math.max(0.1, dive.y - 0.3) + (1 - far) * Math.max(0, dive.y - 1.9)),
      lean: Math.sign(travel) * far * 1.3 * eased,
      stretch: 0.15 + 0.85 * eased * Math.min(1, dive.y / 1.5 + far * 0.8),
    };
    const lift = 14 + result.target.y * 10;
    let ball = {
      x: REST.x + (target.x - REST.x) * share,
      y: REST.y + (target.y - REST.y) * share - lift * 4 * share * (1 - share),
      radius: BALL_REST_RADIUS + (BALL_GOAL_RADIUS - BALL_REST_RADIUS) * share,
      spin: t * 14, alpha: 1,
    };
    let behind = false;
    if (share >= 1) {
      report();
      const after = t - result.flight, fall = Math.min(1, after / 0.7);
      if (result.made) {
        // Into the net: a little deeper, then down to the grass.
        behind = true;
        ball = { ...ball, x: target.x, y: target.y + (GROUND - 8 - target.y) * fall * fall, radius: BALL_GOAL_RADIUS - fall, alpha: 1 };
      } else if (result.kind === "saved" || result.kind === "post") {
        // Back out toward the viewer, away from the middle.
        const away = result.kind === "post" ? -Math.sign(result.target.x || 1) : Math.sign(result.target.x - dive.x || result.target.x || 1);
        ball = { ...ball, x: target.x + away * 46 * fall, y: target.y + (GROUND + 34 - target.y) * fall * fall - 18 * Math.sin(Math.PI * fall),
          radius: BALL_GOAL_RADIUS + 5 * fall, alpha: 1 - Math.max(0, fall - 0.75) * 4 };
      } else {
        // Wide or over: the ball keeps going and gets smaller.
        const dx = target.x - REST.x, dy = target.y - REST.y;
        ball = { ...ball, x: target.x + dx * 0.22 * fall, y: target.y + dy * 0.22 * fall, radius: BALL_GOAL_RADIUS * (1 - 0.45 * fall), alpha: 1 - fall };
        behind = true;
      }
    }
    return { keeper: pose, ball, ballBehind: behind, clock: null,
      netAge: flight.netAt === null ? null : (now - flight.netAt) / 1000, netAt: flight.netAt === null ? null : target };
  }
}
