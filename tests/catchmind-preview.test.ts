import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATCHMIND_RULES } from '../shared/balance';
import { CATCHMIND_WORDS } from '../shared/catchmind-words';
import { catchmindKey, catchmindWordProblem, cleanCatchmindWord, suggestCatchmindWord } from '../shared/catchmind';
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
    engine.mutate('publish', input(engine, { word: '눈사람', image }));
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

  it('publishes the answer the drawer wrote and accepts guesses that differ only in spaces', () => {
    const engine = createCatchmindPreview(viewer);
    engine.mutate('guess', input(engine, { answer: '선인장' }));
    engine.mutate('next', input(engine));
    const draft = engine.read().catchmind;
    expect(draft.round).toMatchObject({ status: 'draft', word: null, image: null });
    expect(draft.canPublish).toBe(true);
    for (const word of [undefined, '', '   ', '가'.repeat(CATCHMIND_RULES.maxWordLength + 1)]) {
      expect(() => engine.mutate('publish', input(engine, { word, image }))).toThrow();
    }
    expect(engine.read().catchmind.round?.status).toBe('draft');
    const published = engine.mutate('publish', input(engine, { word: '  피사의   사탑 ', image })).catchmind.round!;
    expect(published).toMatchObject({ status: 'open', word: '피사의 사탑' });
    // The drawer cannot answer their own drawing; a fresh engine's sample round
    // ('선인장', drawn by someone else) plays the guesser's side.
    const guesser = createCatchmindPreview(viewer);
    expect(guesser.mutate('guess', input(guesser, { answer: '선 인 장' })).catchmind.round).toMatchObject({ status: 'ended', endReason: 'correct' });
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

describe('drawer-written answers', () => {
  it('compares answers without any spaces and stores a tidy answer', () => {
    expect(catchmindKey(' 피사의 사탑 ')).toBe(catchmindKey('피사의사탑'));
    expect(catchmindKey('피사의\t사탑\n')).toBe('피사의사탑');
    expect(catchmindKey('피사의사탑')).not.toBe(catchmindKey('피사의사탐'));
    // Decomposed Hangul (macOS paste) equals the composed form.
    expect(catchmindKey('사탑'.normalize('NFD'))).toBe(catchmindKey('사탑'));
    expect(cleanCatchmindWord('  피사의   사탑 ')).toBe('피사의 사탑');
  });

  it('requires an answer within the length limit', () => {
    expect(catchmindWordProblem('')).not.toBeNull();
    expect(catchmindWordProblem('  \t ')).not.toBeNull();
    expect(catchmindWordProblem('가'.repeat(CATCHMIND_RULES.maxWordLength))).toBeNull();
    expect(catchmindWordProblem(` ${'가'.repeat(CATCHMIND_RULES.maxWordLength)} `)).toBeNull();
    expect(catchmindWordProblem('가'.repeat(CATCHMIND_RULES.maxWordLength + 1))).not.toBeNull();
  });

  it('suggests words from the prompt list and avoids the excluded ones', () => {
    for (let index = 0; index < 50; index++) expect(CATCHMIND_WORDS).toContain(suggestCatchmindWord());
    const [first, second] = CATCHMIND_WORDS;
    expect(suggestCatchmindWord([first], () => 0)).toBe(second);
    expect(suggestCatchmindWord(CATCHMIND_WORDS, () => 0)).toBe(first);
    // Every word in the list fits the answer rules, so a suggestion can always be published.
    expect(CATCHMIND_WORDS.filter(word => catchmindWordProblem(word))).toEqual([]);
  });
});
