import { CLAW_RULES } from "../../shared/balance";
import { MACHINE, CLAW, FPS, moveClaw, planDescent, simulateAttempt, type Board, type SimulationFrame } from "../../shared/claw-physics";
import type { ClawPlayInput, ClawResponse, ClawResult, ClawState } from "../../shared/types";
import type { useClaw } from "../claw-state";
import { ApiFailure } from "../api";
import { reduced } from "../motion";
import { createRenderer, type RenderScene } from "./render";
import { createSound } from "./sound";

export type ClawMode = "idle" | "ready" | "descending" | "waiting" | "playing" | "result";
export interface MachineView {
  mode: ClawMode; status: string; timer: number; x: number; dolls: number;
  muted: boolean; now: number; flashing: boolean; insertion: number;
  result: ClawResult | null; replayMessage: string;
  held: Direction[];
}
type Client = ReturnType<typeof useClaw>;
type Direction = "left" | "right";
const initialStatus = `코인을 넣으면 ${CLAW_RULES.controlDurationMs / 1000}초 동안 집게를 움직일 수 있어요.`;
export const initialView = (): MachineView => ({ mode: "idle", status: initialStatus, timer: CLAW_RULES.controlDurationMs / 1000,
  x: MACHINE.home, dolls: 0, muted: false, now: Date.now(), flashing: false, insertion: 0, result: null, replayMessage: "", held: [] });
const sameIds = (a: Board, b: Board) => a.map(doll => doll.id).join() === b.map(doll => doll.id).join();

/** The original control timing and deterministic replay, with a disposable lifecycle. */
export class ClawController {
  private renderer: ReturnType<typeof createRenderer>;
  private sound = createSound();
  private held = new Set<Direction>();
  private mode: ClawMode = "idle";
  private status = initialStatus;
  private state: ClawState | null = null;
  private clockOffset = 0;
  private deadline = 0;
  private lastTick = CLAW_RULES.controlDurationMs / 1000;
  private lastFrame = 0;
  private lastNotify = 0;
  private frameId = 0;
  private alive = true;
  private insertion = 0;
  private forceStrong = false;
  private result: ClawResult | null = null;
  private replayMessage = "";
  private descent: { board: Board; x: number; bottom: number; stop: boolean; version: number } | null = null;
  private replay: { frames: SimulationFrame[]; index: number; playhead: number; previous: SimulationFrame | null; last: number; result: ClawResult } | null = null;
  private scene: RenderScene = { mode: "idle", board: null, view: { dolls: [], held: null, chute: [] }, prizeFlashUntil: 0,
    claw: { x: MACHINE.home, y: CLAW.top, closed: 0, velocity: 0, swing: 0, swingVelocity: 0 } };
  constructor(canvas: HTMLCanvasElement, private client: () => Client, private update: (view: MachineView) => void) {
    this.renderer = createRenderer(canvas);
    const initial = client().pendingPlay?.board ?? client().state?.board;
    if (initial) this.setScene(initial);
    this.sync();
    this.notify();
    this.frameId = requestAnimationFrame(this.frame);
  }
  private now = () => Date.now() + this.clockOffset;
  private setScene(board: Board) {
    this.scene.board = board;
    this.scene.view = { dolls: board.map(doll => ({ ...doll, x: doll.x * MACHINE.width, y: doll.y * MACHINE.height })), held: null, chute: [] };
  }
  sync() {
    const current = this.client().state;
    if (current && current !== this.state) {
      this.clockOffset = current.serverNow - Date.now();
      this.state = current;
      if (this.mode === "idle" && !this.client().pendingPlay) this.setScene(current.board);
    }
    this.notify();
  }
  get idle() { return this.mode === "idle"; }
  private notify() {
    if (!this.alive) return;
    const client = this.client();
    const status = this.mode === "idle" ? client.pendingPlay ? "같은 시도의 결과를 다시 확인해 주세요. 코인은 중복 사용되지 않아요."
      : this.state?.isAdmin ? "운영자 테스트는 코인 없이 이용해요. 점수와 골드 보상은 없어요."
      : this.state && this.state.coins < 1 ? "코인이 모두 떨어졌어요. 다음 충전을 기다리거나 코인을 살 수 있어요." : this.status : this.status;
    this.update({ mode: this.mode, status, timer: this.mode === "ready" ? Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) : CLAW_RULES.controlDurationMs / 1000,
      x: this.scene.claw.x, dolls: this.scene.view.dolls.length + Number(Boolean(this.scene.view.held)), muted: this.sound.muted,
      now: this.now(), flashing: !reduced() && performance.now() < this.scene.prizeFlashUntil, insertion: this.insertion,
      result: this.result, replayMessage: this.replayMessage, held: [...this.held] });
  }
  private setStatus(message: string) { this.status = message; this.notify(); }
  private setMode(mode: ClawMode) { this.mode = mode; this.scene.mode = mode; this.notify(); }
  press(key: Direction) {
    if (this.mode !== "ready" || this.held.has(key)) return;
    this.held.add(key); this.sound.motor("side"); this.notify();
  }
  release(key: Direction) {
    if (!this.held.delete(key)) return;
    if (!this.held.size && this.mode === "ready") this.sound.motor(null);
    this.notify();
  }
  releaseAll() { this.release("left"); this.release("right"); }
  toggleSound() {
    this.sound.setMuted(!this.sound.muted);
    if (!this.sound.muted) { this.sound.activate(); if (this.mode === "ready") this.sound.music(true); }
    this.notify();
  }
  primary() {
    const client = this.client();
    if (client.busy || client.pendingPurchase) return;
    if (this.mode === "descending" && this.descent) { this.descent.stop = true; this.sound.clack(); return; }
    if (this.mode === "ready") { this.startDescent(); return; }
    if (this.mode !== "idle") return;
    if (client.pendingPlay) { this.sound.activate(); void this.submit(null, client.pendingPlay.board); return; }
    if (!this.state || (!this.state.isAdmin && this.state.coins < 1) || this.state.nextPlayAt > this.now() || client.loading) return;
    this.forceStrong = Boolean(this.state.isAdmin && client.forceStrong);
    this.deadline = performance.now() + CLAW_RULES.controlDurationMs;
    this.lastTick = CLAW_RULES.controlDurationMs / 1000;
    this.replayMessage = "";
    this.insertion++;
    this.sound.coin(); this.sound.music(true); this.sound.buzz(20);
    this.setStatus(`${CLAW_RULES.controlDurationMs / 1000}초 안에 집게를 원하는 친구 위로 옮겨 주세요!`);
    this.setMode("ready");
  }
  private startDescent() {
    if (this.mode !== "ready" || !this.state) return;
    this.releaseAll();
    const claw = this.scene.claw;
    claw.velocity = 0;
    const x = Number(claw.x.toFixed(6)); claw.x = x;
    const board = this.state.board.map(doll => ({ ...doll }));
    this.descent = { board, x, bottom: planDescent(board, x).bottom, stop: false, version: this.state.version };
    this.sound.motor("down");
    this.setStatus("집게가 내려가요… 한 번 더 누르면 그 자리에서 멈춰요!");
    this.setMode("descending");
  }
  private async submit(input: ClawPlayInput | null, board: Board) {
    this.setMode("waiting");
    this.setStatus("집게를 오므리고 있어요…");
    try {
      const response = input ? await this.client().play(input) : await this.client().retryPlay();
      if (!this.alive) return;
      if (!response.result) throw new Error("뽑기 결과를 다시 확인해 주세요.");
      this.sync();
      const result = response.result;
      // A replay failure must never hide a result that the server already saved.
      try {
        const sim = simulateAttempt(board, { x: result.x, stop: result.stop, pickup: result.grip.pickup, carry: result.grip.carry }, { record: true });
        const consistent = result.engine === CLAW_RULES.engine && sim.reason === result.reason && sameIds(sim.prizes, result.prizes)
          && ((result.cleared ?? Boolean(result.clearBonus)) || JSON.stringify(sim.board) === JSON.stringify(response.board));
        if (!consistent || !sim.frames) throw new Error("뽑기 재생이 서버 결과와 달라 결과만 보여 줘요.");
        const index = Math.max(0, sim.frames.findIndex(frame => frame.phase !== "descend"));
        this.replay = { frames: sim.frames, index, playhead: index, previous: null, last: performance.now(), result };
        this.setMode("playing");
      } catch (error) {
        console.warn("뽑기 재생을 확인하지 못해 저장된 결과를 보여 줘요.", error);
        this.replayMessage = "재생을 확인하지 못해 저장된 결과를 보여 드려요.";
        this.showResult(result);
      }
    } catch (error) {
      if (!this.alive) return;
      this.sound.stop();
      this.setStatus(this.client().pendingPlay ? "연결이 잠시 끊겼어요. 같은 시도의 결과를 다시 확인해 주세요." : "기계를 다시 확인해 주세요.");
      this.setMode("idle");
      if (!this.client().pendingPlay || this.client().preview || error instanceof ApiFailure && error.status >= 400 && error.status < 500) { this.resetArm(); void this.client().load(); }
    }
  }
  private apply(frame: SimulationFrame) {
    Object.assign(this.scene.claw, { x: frame.cx / MACHINE.width, y: frame.cy, closed: frame.closed, swing: frame.swing });
    this.scene.view = { dolls: frame.dolls, held: frame.held, chute: frame.chute };
  }
  private cue(before: SimulationFrame | null, frame: SimulationFrame, result: ClawResult) {
    if (!before) return;
    if (frame.phase !== before.phase) {
      if (frame.phase === "lift") { this.sound.motor("up"); this.setStatus(frame.held ? "잡았다! 조금만 더 힘내…" : "빈 집게가 올라가요…"); }
      if (frame.phase === "carry") { this.sound.motor("side"); if (frame.held) this.setStatus("꼭대기 도착! 배출구로 옮기는 중…"); }
      if (frame.phase === "release") { this.sound.motor(null); this.sound.clack(); }
    }
    if (before.closed < .5 && frame.closed >= .5 && frame.phase === "close") { this.sound.clack(); this.sound.buzz(15); }
    if (before.held && !frame.held && frame.phase !== "release") {
      this.sound.slip(); this.sound.buzz([10, 30, 10]);
      this.setStatus(frame.phase === "close" || frame.phase === "lift" ? "앗, 들어 올리다 미끄러졌어요!"
        : frame.cx < MACHINE.width * .35 ? "아깝다! 배출구가 코앞이었는데…" : "툭! 옮기다가 떨어졌어요.");
    }
    if (frame.chute.length > before.chute.length) {
      this.sound.prize(); this.sound.buzz([30, 40, 60]);
      this.scene.prizeFlashUntil = performance.now() + 1200;
      this.setStatus(result.prizes.length > 1 ? "하나 더 굴러 들어갔어요! 덤이다!" : "배출구로 쏙! 내 인형이 됐어요!");
    }
  }
  private showResult(result: ClawResult) {
    this.replay = null; this.result = result;
    this.sound.stop();
    if (!result.prizes.length) this.sound.sad();
    this.setMode("result");
  }
  finish() {
    if (this.mode !== "result") return;
    this.client().completePlay();
    this.result = null; this.scene.prizeFlashUntil = 0;
    this.resetArm();
    if (this.state) this.setScene(this.state.board);
    this.replayMessage = ""; this.status = initialStatus;
    this.setMode("idle");
    void this.client().load();
  }
  private resetArm() { Object.assign(this.scene.claw, { x: MACHINE.home, y: CLAW.top, closed: 0, velocity: 0, swing: 0, swingVelocity: 0 }); }
  private frame = (time: number) => {
    if (!this.alive) return;
    const dt = Math.min((time - (this.lastFrame || time)) / 1000, 1 / 30);
    this.lastFrame = time;
    const claw = this.scene.claw;
    if (this.mode === "ready") {
      const previousVelocity = claw.velocity;
      Object.assign(claw, moveClaw(claw, Number(this.held.has("right")) - Number(this.held.has("left")), dt));
      claw.swingVelocity += (claw.velocity - previousVelocity) * 5;
      const left = Math.ceil((this.deadline - performance.now()) / 1000);
      if (left !== this.lastTick && left <= 5 && left > 0) this.sound.tick(left <= 3);
      this.lastTick = left;
      if (performance.now() >= this.deadline) { this.setStatus("시간 끝! 집게가 그 자리에서 내려가요."); this.startDescent(); }
    }
    if (this.mode === "descending" && this.descent) {
      const descent = this.descent;
      if (!descent.stop && claw.y < descent.bottom) claw.y = Math.min(descent.bottom, claw.y + CLAW.descend * dt * (reduced() ? 2 : 1));
      if (descent.stop || claw.y >= descent.bottom) {
        const stop = claw.y < descent.bottom ? Number(claw.y.toFixed(2)) : null;
        if (stop !== null) claw.y = stop;
        this.sound.motor(null); this.descent = null;
        void this.submit({ requestId: crypto.randomUUID(), version: descent.version, x: descent.x, stop, ...(this.state?.isAdmin ? { forceStrong: this.forceStrong } : {}) }, descent.board);
      }
    }
    if (this.mode === "playing" && this.replay) {
      const replay = this.replay;
      if (replay.index >= replay.frames.length) this.showResult(replay.result);
      else {
        const frame = replay.frames[replay.index];
        if (frame !== replay.previous) { this.cue(replay.previous, frame, replay.result); this.apply(frame); replay.previous = frame; }
        const step = Math.min((time - replay.last) / 1000, 1 / 20); replay.last = time;
        const speed = reduced() ? 2 : frame.chute.length && frame.phase !== "carry" ? .55 : 1;
        replay.playhead += step * FPS * speed; replay.index = Math.floor(replay.playhead);
      }
    } else {
      claw.swingVelocity += (-35 * claw.swing - 5 * claw.swingVelocity) * dt;
      claw.swing = Math.max(-.22, Math.min(.22, claw.swing + claw.swingVelocity * dt));
    }
    this.renderer.draw(time, this.scene);
    if (time - this.lastNotify >= 100) { this.lastNotify = time; this.notify(); }
    this.frameId = requestAnimationFrame(this.frame);
  };
  destroy() { this.alive = false; cancelAnimationFrame(this.frameId); this.renderer.destroy(); this.sound.dispose(); this.held.clear(); }
}
