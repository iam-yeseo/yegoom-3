import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, SimulationFrame } from '../shared/claw-physics';
import type { ClawResponse, ClawResult } from '../shared/types';
import { ClawController, type MachineView } from '../src/claw/controller';
import { framesAfterDescent, simulateReplay } from '../src/claw/replay-simulation';
// @ts-expect-error Independent pre-optimization JavaScript engine fixture.
import * as original from './fixtures/gatcha-physics.original.js';

const mocks = vi.hoisted(() => ({
  draw: vi.fn(), destroy: vi.fn(), invalidate: null as (() => void) | null,
  replayBuild: vi.fn<(board: Board, result: ClawResult, finalBoard: Board) => Promise<SimulationFrame[]>>(),
  replayWarm: vi.fn(), replayDestroy: vi.fn(),
  sound: { muted: true, activate: vi.fn(), coin: vi.fn(), music: vi.fn(), buzz: vi.fn(),
    motor: vi.fn(), clack: vi.fn(), tick: vi.fn(), prize: vi.fn(), slip: vi.fn(), sad: vi.fn(),
    stop: vi.fn(), dispose: vi.fn(), setMuted: vi.fn() },
}));
vi.mock('../src/claw/render', () => ({ createRenderer: (_canvas: HTMLCanvasElement, invalidate?: () => void) => {
  mocks.invalidate = invalidate ?? null;
  return { draw: mocks.draw, resize: vi.fn(), destroy: mocks.destroy };
} }));
vi.mock('../src/claw/sound', () => ({ createSound: () => mocks.sound }));
vi.mock('../src/motion', () => ({ reduced: () => false }));
vi.mock('../src/claw/replay', () => ({ createReplayBuilder: () => ({
  warm: mocks.replayWarm, build: mocks.replayBuild, destroy: mocks.replayDestroy,
}) }));

type Client = ReturnType<ConstructorParameters<typeof ClawController>[1]>;
let documentEvents: EventTarget, visibility: DocumentVisibilityState;
let frames: Map<number, FrameRequestCallback>, sequence: number;
let controller: ClawController | undefined;
let latest: MachineView;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
  vi.clearAllMocks();
  mocks.draw.mockReset();
  mocks.replayBuild.mockImplementation(async (board, result, finalBoard) => simulateReplay(board, result, finalBoard));
  documentEvents = new EventTarget(); visibility = 'visible';
  Object.defineProperties(documentEvents, { visibilityState: { get: () => visibility }, hidden: { get: () => visibility === 'hidden' } });
  vi.stubGlobal('document', documentEvents);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  frames = new Map(); sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => { controller?.destroy(); controller = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function createClient(): Client {
  const state: ClawResponse = { coins: 5, freeCoins: 5, purchasedCoins: 0, nextGrantAt: Date.now() + 3_600_000,
    serverNow: Date.now(), isAdmin: false, board: original.createBoard(1, 1792405194),
    version: 0, generation: 1, nextPlayAt: 0 };
  return { preview: false, state, loading: false, busy: false, error: '', pendingPlay: null, pendingPurchase: null,
    forceStrong: false, setForceStrong: vi.fn(), load: vi.fn(async () => state), buy: vi.fn(async () => state),
    play: vi.fn(async () => state), retryPlay: vi.fn(async () => state), completePlay: vi.fn() };
}
function mount(client: Client) {
  const update = vi.fn((view: MachineView) => { latest = view; });
  controller = new ClawController({} as HTMLCanvasElement, () => client, update);
  return update;
}
async function advance(duration: number) {
  const target = performance.now() + duration;
  while (performance.now() < target - .01) {
    await vi.advanceTimersByTimeAsync(Math.min(1000 / 60, target - performance.now()));
    const scheduled = [...frames.values()]; frames.clear();
    for (const callback of scheduled) callback(performance.now());
    await Promise.resolve();
  }
}
function visible(value: DocumentVisibilityState) {
  visibility = value; documentEvents.dispatchEvent(new Event('visibilitychange'));
}

describe('claw controller schedules only meaningful work', () => {
  it('leaves both React and the settled canvas idle while accepting later invalidation', async () => {
    const client = createClient(), update = mount(client);
    await advance(200);
    update.mockClear(); mocks.draw.mockClear();
    await advance(3000);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.draw).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    mocks.invalidate?.();
    await advance(34);
    expect(mocks.draw).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it('publishes a countdown only when its whole second changes while the carriage moves', async () => {
    const client = createClient(), update = mount(client);
    await advance(34);
    controller!.primary(); controller!.press('right');
    update.mockClear();
    await advance(700);
    expect(update).not.toHaveBeenCalled();
    await advance(1200);
    expect(update.mock.calls.map(([view]) => view.timer)).toEqual([9]);
    expect(mocks.draw.mock.calls.length).toBeGreaterThan(30);
    controller!.release('right');
  });

  it('cancels hidden animation frames and releases a held direction before resuming', async () => {
    const client = createClient(); mount(client);
    controller!.primary(); controller!.press('right');
    await advance(300);
    visible('hidden'); mocks.draw.mockClear();
    await advance(2500);
    expect(frames.size).toBe(0);
    expect(mocks.draw).not.toHaveBeenCalled();
    expect(latest.held).toEqual([]);
    visible('visible'); await advance(34);
    expect(mocks.draw).toHaveBeenCalled();
    expect(latest.timer).toBe(8);
    expect(latest.held).toEqual([]);
  });

  it('does not notify for an identical server sync but wakes a changed board', async () => {
    const client = createClient(), update = mount(client);
    await advance(34); update.mockClear(); mocks.draw.mockClear();
    controller!.sync(); await advance(34);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.draw).not.toHaveBeenCalled();
    client.state = { ...client.state!, board: client.state!.board.slice(1), version: 1 };
    controller!.sync(); await advance(34);
    expect(latest.dolls).toBe(29);
    expect(update).toHaveBeenCalledTimes(1);
    expect(mocks.draw).toHaveBeenCalledTimes(1);
  });
});

function pendingReceipt(admin = false) {
  const board: Board = [{ id: 'saved-final-doll', type: 1, x: .5, y: .8, radius: 32, angle: 0 }];
  const input = { requestId: 'saved-receipt-request', version: 0, x: .5 };
  const simulation = original.simulateAttempt(board, { x: .5, pickup: 1, carry: 1 }, { record: true });
  const result: ClawResult = { requestId: input.requestId, playId: 'saved-play', engine: 2, x: .5, stop: null,
    grip: { pickup: 1, carry: 1, strong: true }, caught: true, prizes: simulation.prizes,
    doll: simulation.prizes[0], target: simulation.target, points: admin ? 0 : 6, gold: admin ? 0 : 310,
    clearBonus: admin ? 0 : 5, clearGold: admin ? 0 : 300, cleared: true, released: simulation.released, reason: simulation.reason };
  const client = createClient();
  const response = { ...client.state!, board: original.createBoard(2, 42), generation: 2, version: 1, isAdmin: admin, result };
  client.state = response;
  client.pendingPlay = { input, board };
  client.retryPlay = vi.fn(async () => response);
  return { board, client, response, simulation };
}

describe('claw controller keeps a previously saved result authoritative', () => {
  it('finishes a zero-based worker replay when its first RAF timestamp predates the worker reply', async () => {
    const { client, response, simulation } = pendingReceipt();
    mocks.replayBuild.mockImplementationOnce(async (board, result, finalBoard) =>
      framesAfterDescent(simulateReplay(board, result, finalBoard)));
    const drawn: unknown[] = [];
    mocks.draw.mockImplementation((_time, scene) => { drawn.push(structuredClone(scene.view)); });
    mount(client);
    await advance(100);
    controller!.primary();
    await vi.advanceTimersByTimeAsync(1);
    expect(latest.mode).toBe('playing');
    const firstFrame = [...frames.values()]; frames.clear();
    expect(firstFrame).toHaveLength(1);
    // rAF timestamps are shared across the browser frame. Its callback may
    // execute after a worker reply whose performance.now() is already later.
    firstFrame[0](performance.now() - 64);
    await advance(20_000);
    expect(latest.mode).toBe('result');
    expect(latest.result).toBe(response.result);
    expect(latest.replayMessage).toBe('');
    const last = simulation.frames.at(-1);
    expect(drawn.at(-1)).toEqual({ dolls: last.dolls, held: last.held, chute: last.chute });
    expect(client.retryPlay).toHaveBeenCalledTimes(1);
    expect(client.completePlay).not.toHaveBeenCalled();
  });

  it.each([false, true])('replays the same final doll positions and unchanged rewards (admin=%s)', async admin => {
    const { client, response, simulation } = pendingReceipt(admin);
    const drawn: Array<unknown> = [];
    mocks.draw.mockImplementation((_time, scene) => { drawn.push(structuredClone(scene.view)); });
    const update = mount(client); controller!.primary();
    await advance(20_000);
    expect(latest.mode).toBe('result');
    expect(latest.result).toBe(response.result);
    expect(latest.result).toMatchObject({ points: admin ? 0 : 6, gold: admin ? 0 : 310, clearBonus: admin ? 0 : 5, clearGold: admin ? 0 : 300 });
    const last = simulation.frames.at(-1);
    expect(drawn.at(-1)).toEqual({ dolls: last.dolls, held: last.held, chute: last.chute });
    expect(client.retryPlay).toHaveBeenCalledTimes(1);
    expect(client.completePlay).not.toHaveBeenCalled();
    update.mockClear(); mocks.draw.mockClear();
    await advance(2000);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.draw).not.toHaveBeenCalled();
  });

  it('shows a saved server result when the physical replay fails validation', async () => {
    const { client, response } = pendingReceipt();
    response.result.engine = 999;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(client); controller!.primary();
    await advance(100);
    expect(latest.mode).toBe('result');
    expect(latest.result).toBe(response.result);
    expect(latest.replayMessage).toContain('저장된 결과');
    expect(client.retryPlay).toHaveBeenCalledTimes(1);
    expect(client.play).not.toHaveBeenCalled();
    expect(client.completePlay).not.toHaveBeenCalled();
  });

  it('cannot restore an old result after the machine is unmounted during replay preparation', async () => {
    const { client, simulation } = pendingReceipt();
    let complete!: (frames: SimulationFrame[]) => void;
    mocks.replayBuild.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const update = mount(client); controller!.primary();
    await advance(34);
    expect(latest.mode).toBe('waiting');
    controller!.destroy(); controller = undefined;
    update.mockClear(); mocks.draw.mockClear();
    complete(simulation.frames);
    await advance(100);
    expect(update).not.toHaveBeenCalled();
    expect(mocks.draw).not.toHaveBeenCalled();
    expect(mocks.replayDestroy).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
});
