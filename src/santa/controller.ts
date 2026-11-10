import { SANTA_WORLD, chimneyX, giftY, judgeDrop, type DropResult, type SantaHouse } from "../../shared/santa-engine";
import { reduced } from "../motion";
import { SantaRenderer, emptyScene, surfaceAt, type GiftSprite, type SantaScene } from "./render";
import type { SantaSound } from "./sound";

export type SantaMode = "idle" | "countdown" | "flying" | "waiting" | "done";
export interface SantaCallbacks {
  /** A gift left the sleigh (release ms) or the house was passed (-1): record it. */
  onDrop(index: number, release: number): void;
  /** The outcome is visible on screen. */
  onResult(index: number, result: DropResult): void;
  onState?(state: { mode: SantaMode; index: number; throwable: boolean }): void;
  /** The next house waits until this is true (the previous drop was recorded). */
  canContinue(): boolean;
  /** Every house of the run is done and its outcome shown. */
  onFinish?(): void;
}
export const COUNTDOWN_MS = 1500;
const CHIMNEY_HALF = SANTA_WORLD.mouthHalf + SANTA_WORLD.wall;
const GIFT = SANTA_WORLD.giftHalf;
const FADE_MS = 700;

interface Approach { index: number; start: number; thrown: boolean }
interface Flight {
  house: SantaHouse; index: number; approachStart: number; releasedAt: number; result: DropResult;
  phase: "fall" | "in" | "bounce" | "drop" | "landed";
  x: number; y: number; vx: number; vy: number; angle: number; spin: number; alpha: number;
  reported: boolean; landedAt: number;
}

/** Owns the canvas: the course timeline, throws, gift flights and the draw loop.
 * Release times are measured on the same clock that positions the chimney, so
 * what the player sees is exactly what the engine judges. */
export class SantaController {
  private renderer: SantaRenderer;
  private scene: SantaScene = emptyScene();
  private course: SantaHouse[] = [];
  private mode: SantaMode = "idle";
  private approach: Approach | null = null;
  private previous: Approach | null = null;
  private countdownUntil = 0;
  private nextIndex = 0;
  private flights: Flight[] = [];
  private glowAt = -Infinity;
  private glowIndex = -1;
  private last = 0;
  private frame = 0;
  private observer: ResizeObserver | null = null;
  private paused = false;

  constructor(private canvas: HTMLCanvasElement, private sound: SantaSound, private callbacks: SantaCallbacks) {
    this.renderer = new SantaRenderer(canvas);
    canvas.addEventListener("pointerdown", this.tap);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => { if (this.renderer.resize()) this.paint(); });
      this.observer.observe(canvas);
    }
    this.renderer.resize();
    this.showIdle(null);
  }
  get current() { return this.mode; }
  get index() { return this.approach?.index ?? this.nextIndex; }
  destroy() {
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.tap);
  }
  /** A calm scene: the sleigh over a house (the course's first one, or a sample). */
  showIdle(house: SantaHouse | null) {
    cancelAnimationFrame(this.frame);
    this.approach = null; this.previous = null; this.flights = [];
    const sample: SantaHouse = house ?? { index: 0, level: 2, top: SANTA_WORLD.tops[2]!, speed: SANTA_WORLD.baseSpeed, approachMs: 0, style: 0, gift: 0 };
    this.scene = { ...emptyScene(), house: { house: sample, x: 250 }, ready: sample.gift, calm: true };
    this.setMode("idle");
    this.paint();
  }
  /** Starts (or resumes) the run at house `from` with a short countdown. */
  run(course: SantaHouse[], from: number) {
    this.course = course; this.nextIndex = from; this.flights = []; this.approach = null; this.previous = null;
    if (from >= course.length) { this.setMode("done"); return; }
    this.scene = { ...emptyScene(), ready: course[from]!.gift, calm: reduced() };
    this.paused = false;
    this.countdownUntil = performance.now() + COUNTDOWN_MS;
    this.sound.activate(); this.sound.start();
    this.setMode("countdown");
    this.loop();
  }
  /** Drops the gift for the house on screen. `at` is the input event's time. */
  throwGift(at = performance.now()): boolean {
    const approach = this.approach;
    if (this.mode !== "flying" || !approach || approach.thrown || this.paused) return false;
    const house = this.course[approach.index]!;
    const now = performance.now();
    const time = Math.abs(at - now) < 1000 ? at : now;
    const release = Math.max(0, Math.round(time - approach.start));
    if (release > house.approachMs) return false;
    approach.thrown = true;
    const result = judgeDrop(house, release);
    this.flights.push({ house, index: approach.index, approachStart: approach.start, releasedAt: approach.start + release, result,
      phase: "fall", x: SANTA_WORLD.sleighX, y: SANTA_WORLD.releaseY, vx: 0, vy: 0, angle: 0, spin: 0, alpha: 1, reported: false, landedAt: 0 });
    this.scene.ready = null;
    this.sound.activate(); this.sound.drop();
    this.callbacks.onDrop(approach.index, release);
    this.emit();
    return true;
  }
  /** The page was hidden: freeze. resume() restarts at the first house not yet thrown. */
  pause() {
    if (this.paused || (this.mode !== "countdown" && this.mode !== "flying" && this.mode !== "waiting")) return;
    this.paused = true;
    cancelAnimationFrame(this.frame);
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    // Outcomes already decided are shown at once; the house on screen starts over unless its gift is out.
    for (const flight of this.flights) this.report(flight);
    const from = this.approach ? this.approach.index + (this.approach.thrown ? 1 : 0) : this.nextIndex;
    this.run(this.course, from);
    if (from >= this.course.length) this.callbacks.onFinish?.();
  }
  /** Stops the run (the server refused it); the scene goes calm. */
  stop() { this.showIdle(null); }

  private tap = (event: PointerEvent) => {
    if (!event.isPrimary || event.button > 0) return;
    if (this.throwGift(event.timeStamp)) event.preventDefault();
  };
  private setMode(mode: SantaMode) { this.mode = mode; this.emit(); }
  private emit() {
    this.callbacks.onState?.({ mode: this.mode, index: this.index, throwable: this.mode === "flying" && !!this.approach && !this.approach.thrown });
  }
  private loop() {
    cancelAnimationFrame(this.frame);
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }
  private startApproach(index: number, start: number) {
    this.previous = this.approach;
    this.approach = { index, start, thrown: false };
    this.scene.ready = this.course[index]!.gift;
    this.setMode("flying");
  }
  private tick = (now: number) => {
    if (this.paused) return;
    const dt = Math.max(0, Math.min(50, now - this.last));
    this.last = now;
    this.scene.time = now;
    this.scene.calm = reduced();
    if (this.mode === "countdown" && now >= this.countdownUntil) {
      if (this.callbacks.canContinue()) this.startApproach(this.nextIndex, now); else this.setMode("waiting");
    } else if (this.mode === "waiting" && this.callbacks.canContinue()) this.startApproach(this.nextIndex, now);
    if (this.mode === "flying") this.fly(now, dt);
    this.updateFlights(now, dt);
    const glow = Math.max(0, 1 - (now - this.glowAt) / 900);
    this.scene.glow = glow > 0 ? { index: this.glowIndex, amount: glow } : null;
    this.paint();
    const busy = this.mode === "countdown" || this.mode === "flying" || this.mode === "waiting" || this.flights.length > 0 || glow > 0;
    if (busy) this.frame = requestAnimationFrame(this.tick);
    else if (this.mode === "done") this.callbacks.onFinish?.();
  };
  private fly(now: number, dt: number) {
    const approach = this.approach!, house = this.course[approach.index]!;
    const t = now - approach.start;
    this.scene.distance += house.speed * dt;
    this.scene.house = { house, x: chimneyX(house, t) };
    const previous = this.previous;
    this.scene.leaving = previous ? { house: this.course[previous.index]!, x: chimneyX(this.course[previous.index]!, now - previous.start) } : null;
    if (t < house.approachMs) return;
    if (!approach.thrown) {
      approach.thrown = true;
      this.scene.ready = null;
      this.callbacks.onDrop(approach.index, -1);
      this.callbacks.onResult(approach.index, judgeDrop(house, -1));
      this.sound.pass();
    }
    const next = approach.index + 1;
    this.nextIndex = next;
    if (next >= this.course.length) { this.previous = approach; this.approach = null; this.setMode("done"); return; }
    // Chained houses keep the exact rhythm; a house that waited for the network starts now.
    if (this.callbacks.canContinue()) this.startApproach(next, approach.start + house.approachMs);
    else { this.previous = approach; this.approach = null; this.setMode("waiting"); }
  }
  private report(flight: Flight) {
    if (flight.reported) return;
    flight.reported = true;
    this.callbacks.onResult(flight.index, flight.result);
  }
  private updateFlights(now: number, dt: number) {
    const gravity = SANTA_WORLD.gravity;
    for (const flight of this.flights) {
      const { house, result } = flight;
      const chimney = chimneyX(house, now - flight.approachStart);
      const tau = now - flight.releasedAt;
      if (flight.phase === "fall") {
        flight.y = giftY(Math.min(tau, result.fallMs));
        if (tau >= result.fallMs) {
          flight.vy = gravity * result.fallMs;
          if (result.kind === "in") { flight.phase = "in"; this.glowAt = now; this.glowIndex = flight.index; this.sound.hit(); }
          else if (result.kind === "rim-early" || result.kind === "rim-late") {
            flight.phase = "bounce"; flight.vy = -0.32; flight.vx = result.kind === "rim-early" ? -0.1 : 0.12;
            flight.spin = result.kind === "rim-early" ? -0.012 : 0.012; this.sound.rim();
          } else flight.phase = "drop";
          this.report(flight);
        }
      } else if (flight.phase === "in") {
        flight.x = chimney - result.dx;
        flight.vy += gravity * dt; flight.y += flight.vy * dt;
      } else if (flight.phase === "bounce" || flight.phase === "drop") {
        flight.vy += gravity * dt; flight.x += flight.vx * dt; flight.y += flight.vy * dt; flight.angle += flight.spin * dt;
        // An early gift beside the chimney is nudged along by its wall.
        if (flight.phase === "drop" && flight.y > house.top && flight.x + GIFT > chimney - CHIMNEY_HALF && flight.x < chimney) flight.x = chimney - CHIMNEY_HALF - GIFT;
        const floor = surfaceAt(house.style, chimney, flight.x) - GIFT;
        if (flight.y >= floor && flight.vy > 0) { flight.y = floor; flight.phase = "landed"; flight.landedAt = now; this.sound.thud(); }
      } else {
        flight.x -= house.speed * dt;
        flight.alpha = Math.max(0, 1 - (now - flight.landedAt) / FADE_MS);
      }
    }
    this.flights = this.flights.filter(flight => (flight.phase === "in" ? flight.y < flight.house.top + 50 : flight.alpha > 0 && flight.y < 600));
    this.scene.gifts = this.flights.map((flight): GiftSprite => ({ x: flight.x, y: flight.y, angle: flight.angle, color: flight.house.gift, alpha: flight.alpha,
      clipBelow: flight.phase === "in" ? flight.house.top + 3 : null }));
  }
  private paint() { this.renderer.draw(this.scene); }
}
