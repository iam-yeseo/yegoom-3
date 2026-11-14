import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSource {
  buffer: unknown = null; loop = false; onended: (() => void) | null = null;
  playbackRate = { value: 1, setTargetAtTime: vi.fn() };
  start = vi.fn(); stop = vi.fn(); disconnect = vi.fn();
  connect(node: unknown) { return node; }
}
class FakeGain { gain = { value: 1 }; connect(node: unknown) { return node; } disconnect = vi.fn(); }
let sources: FakeSource[], gains: FakeGain[], contexts: number;
class FakeContext {
  state = 'running'; currentTime = 0; destination = {};
  constructor() { contexts++; }
  createGain() { const gain = new FakeGain(); gains.push(gain); return gain; }
  createBufferSource() { const source = new FakeSource(); sources.push(source); return source; }
  decodeAudioData = vi.fn(async () => ({ duration: .5 }));
  resume = vi.fn(async () => {});
}
let store: Map<string, string>;
const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  sources = []; gains = []; contexts = 0; store = new Map();
  fetchMock.mockClear();
  vi.stubGlobal('window', { AudioContext: FakeContext });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe('sound effects', () => {
  it('ships a file for every sound', async () => {
    const names = ['tap', 'sheet-open', 'sheet-close', 'notify', 'coin', 'coin-big', 'purchase', 'error',
      'slot-lever', 'slot-spin', 'slot-stop', 'slot-jackpot', 'slot-lose'];
    for (const name of names) expect(existsSync(`public/sfx/${name}.mp3`), name).toBe(true);
  });

  it('fetches a sound once and plays it at its own level', async () => {
    const { playSfx } = await import('../src/sfx');
    playSfx('coin');
    await flush();
    playSfx('coin', { gain: 2, rate: .9 });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/sfx/coin.mp3');
    expect(contexts).toBe(1);
    expect(sources.map(source => source.start.mock.calls.length)).toEqual([1, 1]);
    expect(sources[1].playbackRate.value).toBe(.9);
    // gains[0] is the master; each play adds one.
    expect(gains[2].gain.value).toBeCloseTo(gains[1].gain.value * 2);
  });

  it('stays silent and creates nothing when turned off, and remembers it', async () => {
    const { playSfx, readSfxEnabled, saveSfxEnabled } = await import('../src/sfx');
    expect(readSfxEnabled()).toBe(true);
    saveSfxEnabled(false);
    expect(store.get('yegoom3:sfx')).toBe('off');
    playSfx('tap');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(contexts).toBe(0);
    vi.resetModules();
    expect((await import('../src/sfx')).readSfxEnabled()).toBe(false);
  });

  it('stops a loop that is stopped before its file has loaded', async () => {
    const { loopSfx } = await import('../src/sfx');
    const spin = loopSfx('slot-spin');
    spin.stop();
    await flush();
    expect(sources).toHaveLength(1);
    expect(sources[0].loop).toBe(true);
    expect(sources[0].stop).toHaveBeenCalled();
  });

  it('turning sounds off stops a running loop', async () => {
    const { loopSfx, saveSfxEnabled } = await import('../src/sfx');
    loopSfx('slot-spin');
    await flush();
    saveSfxEnabled(false);
    expect(sources[0].stop).toHaveBeenCalled();
  });
});
