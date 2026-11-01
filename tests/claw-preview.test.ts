import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAW_RULES } from '../shared/balance';
import * as physics from '../shared/claw-physics';
import { createClawPreview, previewClawSummary } from '../src/claw-preview';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T08:59:59+09:00'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('offline claw preview', () => {
  it('reads the home wallet without creating a physical board', () => {
    const create = vi.spyOn(physics, 'createBoard');
    const preview = createClawPreview();
    expect(previewClawSummary()).toMatchObject({ freeCoins: 5, purchasedCoins: 0, coins: 5 });
    expect(preview.summary()).toEqual(previewClawSummary());
    expect(create).not.toHaveBeenCalled();
    expect(preview.read().board).toHaveLength(30);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refills at the KST boundary without rollover and spends free coins before purchased coins', () => {
    const preview = createClawPreview();
    const purchased = preview.buy({ requestId: 'preview-buy-five-coins', quantity: 5 }, 500);
    expect(purchased).toMatchObject({ freeCoins: 5, purchasedCoins: 5 });
    let state = preview.play({ requestId: 'preview-first-play', version: purchased.version, x: .05 });
    expect(state).toMatchObject({ freeCoins: 4, purchasedCoins: 5 });
    vi.setSystemTime(new Date('2026-11-02T09:00:00+09:00'));
    expect(preview.read()).toMatchObject({ freeCoins: 5, purchasedCoins: 5, coins: 10 });
    vi.setSystemTime(new Date('2026-11-02T18:00:00+09:00'));
    expect(preview.read()).toMatchObject({ freeCoins: 5, purchasedCoins: 5, coins: 10 });
    for (let index = 0; index < 6; index++) {
      state = preview.play({ requestId: `preview-consume-coin-${index}`, version: state.version, x: .05 });
      vi.advanceTimersByTime(CLAW_RULES.playDurationMs);
    }
    expect(state).toMatchObject({ freeCoins: 0, purchasedCoins: 4, coins: 4 });
    expect(preview.gold).toBe(-500);
    expect(preview.score).toBe(0);
  });

  it('replays purchases without charging twice and uses the latest combined preview balance', () => {
    const preview = createClawPreview();
    const input = { requestId: 'preview-coins-purchase', quantity: 1 as const };
    expect(() => preview.buy(input, 99)).toThrow('골드가 부족');
    expect(preview.gold).toBe(0);
    expect(preview.buy(input, 100)).toMatchObject({ purchasedCoins: 1, replayed: false });
    expect(preview.buy(input, 0)).toMatchObject({ purchasedCoins: 1, replayed: true });
    expect(() => preview.buy({ ...input, quantity: 5 }, 1000)).toThrow('다른 구매');
    expect(preview.gold).toBe(-100);
    expect(preview.ledger).toHaveLength(1);
  });

  it('replays the same physical result and reward once while enforcing version and cooldown', () => {
    let draw = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = draw++ === 0 ? 1792405194 : 0;
      return array;
    }) as typeof crypto.getRandomValues);
    const simulate = vi.spyOn(physics, 'simulateAttempt');
    const preview = createClawPreview();
    const before = preview.read();
    const input = { requestId: 'preview-idempotent-play', version: before.version, x: .5 };
    const response = preview.play(input);
    expect(response.result).toMatchObject({ caught: true, points: 1, gold: 10, clearBonus: 0, clearGold: 0 });
    const result = response.result!;
    const replay = physics.simulateAttempt(before.board, { x: result.x, stop: result.stop, ...result.grip });
    expect(replay.board).toEqual(response.board);
    expect(replay.prizes).toEqual(result.prizes);
    const calls = simulate.mock.calls.length;
    expect(preview.play({ ...input, stop: null })).toMatchObject({ replayed: true, result });
    expect(simulate).toHaveBeenCalledTimes(calls);
    expect(() => preview.play({ ...input, x: .6 })).toThrow('다른 플레이');
    expect(() => preview.play({ ...input, requestId: 'preview-stale-version' })).toThrow('기계 상태가 바뀌');
    expect(() => preview.play({ ...input, requestId: 'preview-too-soon-play', version: response.version })).toThrow('아직 움직이고');
    expect(preview.gold).toBe(10);
    expect(preview.score).toBe(1);
    expect(preview.ledger).toHaveLength(2);
    result.prizes[0].type = 999;
    response.board.length = 0;
    expect(preview.play(input).result!.prizes[0].type).not.toBe(999);
    expect(preview.read().board).toHaveLength(29);
    expect(createClawPreview().summary()).toMatchObject({ coins: 5, freeCoins: 5, purchasedCoins: 0 });
  });
});
