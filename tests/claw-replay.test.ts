import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAW, MACHINE, type AttemptInput, type AttemptResult, type Board } from '../shared/claw-physics';
import type { ClawResult } from '../shared/types';
import { framesAfterDescent, simulateReplay } from '../src/claw/replay-simulation';
import { createReplayBuilder, type ReplayJob, type ReplayReply } from '../src/claw/replay';
// The independently preserved, pre-optimization engine is the replay oracle.
// @ts-expect-error The original fixture intentionally has no TypeScript port.
import * as original from './fixtures/gatcha-physics.original.js';

function receipt(board: Board, input: AttemptInput, admin = false) {
  const simulation = original.simulateAttempt(board, input, { record: true }) as AttemptResult;
  const cleared = simulation.prizes.length > 0 && simulation.board.length === 0;
  const clearBonus = !admin && cleared ? 5 : 0;
  const clearGold = !admin && cleared ? 300 : 0;
  const result: ClawResult = {
    requestId: 'immutable-server-result', playId: 'saved-play', engine: 2,
    x: input.x, stop: input.stop ?? null,
    grip: { pickup: input.pickup ?? 1, carry: input.carry ?? 1, strong: input.pickup === 1 && input.carry === 1 },
    caught: simulation.prizes.length > 0, prizes: simulation.prizes, doll: simulation.prizes[0] ?? null,
    target: simulation.target, points: admin ? 0 : simulation.prizes.length + clearBonus,
    gold: admin ? 0 : simulation.prizes.length * 10 + clearGold,
    clearBonus, clearGold, cleared, released: simulation.released, reason: simulation.reason,
  };
  return { result, simulation };
}

const samples = Array.from({ length: 24 }, (_, index) => {
  const seed = (Math.imul(index + 1, 1792405194) >>> 0);
  const board = original.createBoard(index % 3 + 1, seed) as Board;
  const target = board[index % board.length];
  const input = {
    x: index % 4 === 0 ? MACHINE.clawMin : index % 4 === 1 ? MACHINE.clawMax : target.x,
    stop: index % 5 === 0 ? CLAW.top : index % 5 === 1 ? 180 : null,
    pickup: index % 3 === 0 ? 1 : .45,
    carry: index % 3 === 0 ? 1 : index % 3 === 1 ? .05 : .3,
  };
  return { index, seed, board, input };
});

describe('replay worker request lifecycle', () => {
  let workers: WorkerStub[];
  const builders: ReturnType<typeof createReplayBuilder>[] = [];
  class WorkerStub {
    jobs: ReplayJob[] = [];
    onmessage: ((event: MessageEvent<ReplayReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn((job: ReplayJob) => { this.jobs.push(structuredClone(job)); });
    constructor() { workers.push(this); }
    complete(index = 0) {
      const job = this.jobs[index];
      const frames = simulateReplay(job.board, job.result, job.finalBoard);
      this.onmessage?.(new MessageEvent<ReplayReply>('message', { data: { id: job.id, frames } }));
      return frames;
    }
  }
  beforeEach(() => { workers = []; vi.stubGlobal('Worker', WorkerStub); });
  afterEach(() => { for (const builder of builders.splice(0)) builder.destroy(); vi.unstubAllGlobals(); });
  function builder() { const instance = createReplayBuilder(); builders.push(instance); return instance; }
  function job(index = 2) {
    const { board, input } = samples[index];
    const { result, simulation } = receipt(board, input);
    return { board, result, finalBoard: simulation.board };
  }

  it('warms one worker without computing a result and correlates concurrent replies in either order', async () => {
    const replay = builder(); replay.warm(); replay.warm();
    expect(workers).toHaveLength(1);
    expect(workers[0].postMessage).not.toHaveBeenCalled();
    const first = job(2), second = job(3);
    const a = replay.build(first.board, first.result, first.finalBoard);
    const b = replay.build(second.board, second.result, second.finalBoard);
    expect(workers[0].jobs.map(job => job.id)).toEqual([1, 2]);
    // An unrelated or late reply cannot consume a pending saved result.
    workers[0].onmessage?.(new MessageEvent<ReplayReply>('message', { data: { id: 999, frames: [] } }));
    const secondFrames = workers[0].complete(1), firstFrames = workers[0].complete(0);
    expect(await b).toEqual(secondFrames);
    expect(await a).toEqual(firstFrames);
  });

  it('rejects a failed physical validation without poisoning other saved results', async () => {
    const replay = builder(), input = job();
    const invalid = replay.build(input.board, input.result, input.finalBoard);
    const rejected = expect(invalid).rejects.toThrow('fixture: mismatched final board');
    workers[0].onmessage?.(new MessageEvent<ReplayReply>('message', { data: { id: 1, error: 'fixture: mismatched final board' } }));
    await rejected;
    const valid = replay.build(input.board, input.result, input.finalBoard);
    const expectedFrames = workers[0].complete(1);
    expect(await valid).toEqual(expectedFrames);
    expect(workers).toHaveLength(1);
  });

  it.each(['error', 'messageerror'] as const)('rejects every pending job after worker %s and never repeats physical work on the UI thread', async kind => {
    const replay = builder(), input = job();
    const first = replay.build(input.board, input.result, input.finalBoard).catch(error => error);
    const second = replay.build(input.board, input.result, input.finalBoard).catch(error => error);
    if (kind === 'error') workers[0].onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    else workers[0].onmessageerror?.();
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await expect(replay.build(input.board, input.result, input.finalBoard)).rejects.toThrow();
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects and releases in-flight work on disposal, ignoring a late worker reply', async () => {
    const replay = builder(), input = job();
    const pending = replay.build(input.board, input.result, input.finalBoard).catch(error => error);
    replay.destroy();
    expect(await pending).toBeInstanceOf(Error);
    workers[0].complete();
    await expect(replay.build(input.board, input.result, input.finalBoard)).rejects.toThrow('종료');
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported workers so the saved receipt remains available to the controller', async () => {
    vi.stubGlobal('Worker', undefined);
    const replay = builder(), input = job();
    replay.warm();
    await expect(replay.build(input.board, input.result, input.finalBoard)).rejects.toThrow('브라우저');
    expect(workers).toEqual([]);
  });
});

describe('optimized replay preserves the saved physical outcome', () => {
  it.each(samples)('preserves every original frame and final doll position for seed $seed (case $index)', ({ board, input }) => {
    const { result, simulation } = receipt(board, input);
    const before = JSON.stringify({ board, result, finalBoard: simulation.board });
    const frames = simulateReplay(board, result, simulation.board);
    expect(JSON.stringify(frames)).toBe(JSON.stringify(simulation.frames));
    const firstVisible = Math.max(0, simulation.frames!.findIndex(frame => frame.phase !== 'descend'));
    const visibleFrames = framesAfterDescent(frames);
    expect(JSON.stringify(visibleFrames)).toBe(JSON.stringify(simulation.frames!.slice(firstVisible)));
    expect(visibleFrames[0]).toBe(frames[firstVisible]);
    expect(frames.at(-1)).toEqual(simulation.frames!.at(-1));
    expect(JSON.stringify({ board, result, finalBoard: simulation.board })).toBe(before);
    // The replay renders the receipt; it must not recompute or alter rewards.
    expect(result.points).toBe(simulation.prizes.length + result.clearBonus);
    expect(result.gold).toBe(simulation.prizes.length * 10 + result.clearGold);
  });

  it('replays a cleared board before the server-generated next machine without changing its reward', () => {
    const board: Board = [{ id: 'last-doll', type: 1, x: .5, y: .8, radius: 32, angle: 0 }];
    const { result, simulation } = receipt(board, { x: .5, pickup: 1, carry: 1 });
    expect(result).toMatchObject({ cleared: true, points: 6, gold: 310, clearBonus: 5, clearGold: 300 });
    expect(simulation.board).toEqual([]);
    const nextBoard = original.createBoard(2, 0x12345678) as Board;
    expect(simulateReplay(board, result, nextBoard)).toEqual(simulation.frames);
    expect(nextBoard).toHaveLength(30);
  });

  it('uses identical animation and final positions for an administrator receipt with no rewards', () => {
    const board: Board = [{ id: 'admin-last-doll', type: 1, x: .5, y: .8, radius: 32, angle: 0 }];
    const { result, simulation } = receipt(board, { x: .5, pickup: 1, carry: 1 }, true);
    expect(result).toMatchObject({ cleared: true, points: 0, gold: 0, clearBonus: 0, clearGold: 0 });
    expect(simulateReplay(board, result, original.createBoard(2, 42))).toEqual(simulation.frames);
    expect(result).toMatchObject({ points: 0, gold: 0 });
  });

  it.each(['engine', 'reason', 'prizes', 'board'] as const)('rejects a replay whose %s differs from the saved server result', mismatch => {
    const board: Board = [{ id: 'saved-doll', type: 1, x: .5, y: .8, radius: 32, angle: 0 }];
    const { result, simulation } = receipt(board, { x: MACHINE.clawMin, pickup: 1, carry: 1 });
    expect(result.cleared).toBe(false);
    const finalBoard = structuredClone(simulation.board);
    if (mismatch === 'engine') result.engine = 999;
    else if (mismatch === 'reason') result.reason = result.reason === 'miss' ? 'caught' : 'miss';
    else if (mismatch === 'prizes') result.prizes = [{ ...board[0], id: 'different-prize' }];
    else finalBoard[0].x += .000001;
    expect(() => simulateReplay(board, result, finalBoard)).toThrow();
  });
});
