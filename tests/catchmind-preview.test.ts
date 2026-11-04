import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATCHMIND_RULES } from '../shared/balance';
import { CATCHMIND_WORDS } from '../shared/catchmind-words';
import type { CatchmindInput, CatchmindPlayer } from '../shared/types';
import { createCatchmindPreview } from '../src/catchmind-preview';

const viewer: CatchmindPlayer = { id: 'yeseo', username: 'yeseo', displayName: '예서', photoVersion: null, character: 'bunny' };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1AAAAAASUVORK5CYII=';
type Engine = ReturnType<typeof createCatchmindPreview>;
let request = 0;
const input = (engine: Engine, extra: object = {}): CatchmindInput => ({
  requestId: `preview-request-${++request}`, roundId: engine.read().catchmind.round?.id ?? null, ...extra,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T00:00:00Z')); request = 0; });
afterEach(() => { vi.useRealTimers(); });

function finishMyDrawing(engine: Engine) {
  const draft = engine.read().catchmind.round!;
  engine.mutate('publish', input(engine, { wordVersion: draft.wordVersion, image }));
  engine.mutate('end', input(engine));
  vi.setSystemTime(Date.now() + CATCHMIND_RULES.skipAfterMs);
  while (!engine.read().catchmind.canNext) {
    engine.mutate('skip', input(engine, { expectedTurnId: engine.read().catchmind.turn!.id }));
  }
}

describe('offline Catchmind rules', () => {
  it('reveals the fifth-miss hint and ends at ten without rewards, then rotates from the drawer', () => {
    const engine = createCatchmindPreview(viewer);
    for (let miss = 3; miss <= CATCHMIND_RULES.endAfter; miss++) {
      const view = engine.mutate('guess', input(engine, { answer: `다른답${miss}` }));
      expect(view.catchmind.round?.wrongCount).toBe(miss);
      expect(Boolean(view.catchmind.round?.hint)).toBe(miss >= CATCHMIND_RULES.hintAfter);
      expect(view.catchmind.round?.status).toBe(miss === CATCHMIND_RULES.endAfter ? 'ended' : 'open');
    }
    expect(engine.read().catchmind).toMatchObject({ turn: { username: 'yeseo' }, canNext: true,
      round: { winner: null, endReason: 'misses' } });
    expect([engine.gold, engine.score, engine.ledger.length]).toEqual([0, 0, 0]);
  });

  it('uses the username cycle for correct and manual endings and guards timed skip retries', () => {
    const engine = createCatchmindPreview(viewer);
    engine.mutate('guess', input(engine, { answer: '선인장' }));
    expect(engine.read().catchmind.turn?.username).toBe('yeseo');
    expect([engine.gold, engine.score]).toEqual([CATCHMIND_RULES.gold, CATCHMIND_RULES.score]);
    engine.mutate('next', input(engine));
    const draft = engine.read().catchmind.round!;
    expect(draft.drawer.username).toBe('yeseo');
    engine.mutate('publish', input(engine, { wordVersion: draft.wordVersion, image }));
    engine.mutate('end', input(engine));
    expect(engine.read().catchmind.turn?.username).toBe('min');
    vi.setSystemTime(Date.now() + CATCHMIND_RULES.skipAfterMs - 1);
    const skip = input(engine, { expectedTurnId: 'min' });
    expect(() => engine.mutate('skip', skip)).toThrow();
    vi.setSystemTime(Date.now() + 1);
    const skipped = engine.mutate('skip', skip);
    expect(skipped.catchmind.turn?.username).toBe('siwon');
    expect(engine.mutate('skip', skip).version).toBe(skipped.version);
    expect(() => engine.mutate('skip', input(engine, { expectedTurnId: 'min' }))).toThrow();
  });

  it('does not reuse shown prompts or rerolls until the 400-word pool is exhausted', () => {
    const engine = createCatchmindPreview(viewer);
    engine.mutate('guess', input(engine, { answer: '선인장' }));
    const shown = new Set(['선인장']);
    while (shown.size < CATCHMIND_WORDS.length) {
      engine.mutate('next', input(engine));
      let draft = engine.read().catchmind.round!;
      expect(shown.has(draft.word!)).toBe(false); shown.add(draft.word!);
      // Consume rerolls too, without resetting the pool in the middle of this
      // assertion. Every word shown by either action shares the same history.
      for (let reroll = 0; reroll < CATCHMIND_RULES.rerolls && shown.size < CATCHMIND_WORDS.length; reroll++) {
        draft = engine.mutate('reroll', input(engine, { wordVersion: draft.wordVersion })).catchmind.round!;
        expect(shown.has(draft.word!)).toBe(false); shown.add(draft.word!);
      }
      finishMyDrawing(engine);
    }
    expect(shown.size).toBe(400);
    expect(engine.wordsRemaining).toBe(0);
    engine.mutate('next', input(engine));
    expect(engine.wordsRemaining).toBe(399);
    expect(CATCHMIND_WORDS).toContain(engine.read().catchmind.round?.word);
  });

  it('returns a viewer-scoped unchanged version and preserves successful mutation identities', () => {
    const engine = createCatchmindPreview(viewer);
    const before = engine.read();
    expect(engine.read(before.version)).toEqual({ unchanged: true, version: before.version, viewerId: viewer.id,
      serverTime: new Date().toISOString() });
    const attempt = input(engine, { answer: '선인장' });
    const solved = engine.mutate('guess', attempt);
    expect(solved.version).toBe(before.version + 1);
    expect(engine.mutate('guess', attempt).version).toBe(solved.version);
    expect(() => engine.mutate('guess', { ...attempt, answer: '다른말' })).toThrow();
    expect(engine.ledger).toHaveLength(2);
  });
});
