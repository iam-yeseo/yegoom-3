import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as physics from '../shared/claw-physics';
import { createRenderer, type RenderScene } from '../src/claw/render';

vi.mock('../src/motion', () => ({ reduced: () => false }));

type Method = ReturnType<typeof vi.fn>;
interface Surface {
  width: number; height: number;
  calls: Map<string, Method>; writes: Array<[string, unknown]>;
  getContext: Method;
  getBoundingClientRect(): { width: number; height: number };
}
class Sprite {
  src = ''; decoding = ''; complete = true; naturalWidth = 200; naturalHeight = 160;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { sprites.push(this); }
}
let surfaces: Surface[], sprites: Sprite[], bounds: { width: number; height: number };
let resizeCallback: () => void;
let renderer: ReturnType<typeof createRenderer> | undefined;

function surface(): Surface {
  const calls = new Map<string, Method>(), writes: Array<[string, unknown]> = [];
  const context = new Proxy({}, {
    get(_target, key: string) {
      if (!calls.has(key)) calls.set(key, vi.fn());
      return calls.get(key);
    },
    set(_target, key: string, value) { writes.push([key, value]); return true; },
  }) as CanvasRenderingContext2D;
  const node = { width: 0, height: 0, calls, writes, getContext: vi.fn(() => context), getBoundingClientRect: () => bounds };
  surfaces.push(node);
  return node;
}
beforeEach(() => {
  surfaces = []; sprites = []; bounds = { width: 400, height: 280 };
  vi.stubGlobal('Image', Sprite);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { devicePixelRatio: 3 }));
  vi.stubGlobal('document', { createElement: () => surface(), fonts: { ready: Promise.resolve() } });
});
afterEach(() => { renderer?.destroy(); renderer = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function scene(): RenderScene {
  const board: physics.Board = [
    { id: 'b', type: 1, x: .3, y: .7, radius: 32, angle: 0 },
    { id: 'a', type: 2, x: .4, y: .7, radius: 32, angle: 0 },
    { id: 'c', type: 1, x: .6, y: .6, radius: 32, angle: 0 },
  ];
  return { mode: 'idle', board, prizeFlashUntil: 0,
    claw: { x: .1, y: 48, closed: 0, swing: 0, velocity: 0, swingVelocity: 0 },
    view: { dolls: board.map(doll => ({ ...doll, x: doll.x * 600, y: doll.y * 420 })), held: null, chute: [] } };
}
async function mount() {
  const node = surface(), invalidate = vi.fn();
  renderer = createRenderer(node as unknown as HTMLCanvasElement, invalidate);
  await Promise.resolve(); // The app font invalidates its cached text once.
  invalidate.mockClear();
  return { node, invalidate };
}

describe('claw renderer caches only reusable artwork and calculations', () => {
  it('caps backing pixels at DPR2 and releases old artwork when its display size changes', async () => {
    const { node, invalidate } = await mount(), current = scene();
    expect([node.width, node.height]).toEqual([800, 560]);
    expect(node.getContext).toHaveBeenCalledWith('2d', { alpha: false, desynchronized: true });
    expect(node.writes).toContainEqual(['fillStyle', '#E3F1FC']);
    expect(node.calls.get('fillRect')).toHaveBeenLastCalledWith(0, 0, 600, 420);
    renderer!.draw(0, current);
    const cached = surfaces.slice(1);
    const copied = (layer: Surface) => node.calls.get('drawImage')!.mock.calls.find(args => args[0] === layer)!;
    // At 800×560 the divider/track fit in these integer pixel strips. Their
    // destination positions map back to the exact same source pixels.
    const panel = copied(cached[1]), track = copied(cached[3]);
    expect(panel.slice(1, 5)).toEqual([0, 210, 800, 350]);
    expect(track.slice(1, 5)).toEqual([0, 0, 800, 30]);
    expect(panel[6] * 560 / 420).toBe(210);
    expect(panel[8] * 560 / 420).toBe(350);
    expect(track[8] * 560 / 420).toBe(30);
    expect(cached.every(layer => layer.getContext.mock.calls.every(args => args.length === 1 && args[0] === '2d'))).toBe(true);
    const initialFills = node.calls.get('fillRect')!.mock.calls.length;
    bounds = { width: 500, height: 350 };
    resizeCallback();
    expect([node.width, node.height]).toEqual([1000, 700]);
    expect(node.calls.get('fillRect')!.mock.calls.length).toBe(initialFills + 1);
    expect(node.calls.get('fillRect')).toHaveBeenLastCalledWith(0, 0, 600, 420);
    expect(cached.every(layer => layer.width === 0 && layer.height === 0)).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
    renderer!.draw(16, current);
    expect(surfaces.length).toBeGreaterThan(cached.length + 1);
    const resized = surfaces.slice(cached.length + 1);
    expect(copied(resized[1]).slice(1, 5)).toEqual([0, 263, 1000, 437]);
    expect(copied(resized[3]).slice(1, 5)).toEqual([0, 0, 1000, 37]);
  });

  it('reuses static layers and baked shadows across repeated frames and changed doll objects', async () => {
    const { node } = await mount(), current = scene();
    renderer!.draw(0, current);
    const allocated = surfaces.length;
    const shadowWrites = () => surfaces.flatMap(surface => surface.writes).filter(([property]) => property === 'shadowBlur').length;
    const shadows = shadowWrites();
    expect(shadows).toBe(2); // Two type/size pairs among three dolls.
    for (let index = 1; index <= 10; index++) renderer!.draw(index * 16, current);
    current.view.dolls = current.view.dolls.map(doll => ({ ...doll, x: doll.x + 1 }));
    renderer!.draw(180, current);
    expect(surfaces.length).toBe(allocated);
    expect(shadowWrites()).toBe(shadows);
    expect(node.writes.filter(([property]) => property === 'shadowBlur')).toEqual([]);
  });

  it('retains stable height order without sorting again until dolls cross', async () => {
    const { node } = await mount(), current = scene();
    const sort = vi.spyOn(Array.prototype, 'sort');
    const counts: number[] = [];
    const draw = () => { const before = sort.mock.calls.length; renderer!.draw(0, current); counts.push(sort.mock.calls.length - before); };
    draw(); draw();
    current.view.dolls = current.view.dolls.map(doll => ({ ...doll, x: doll.x + 1 }));
    draw();
    current.view.dolls = current.view.dolls.map((doll, index) => ({ ...doll, y: index === 1 ? 200 : doll.y }));
    node.calls.get('translate')!.mockClear();
    draw();
    sort.mockRestore();
    expect(counts).toEqual([1, 0, 0, 1]);
    expect(node.calls.get('translate')!.mock.calls.slice(0, 3)).toEqual([[241, 200], [361, 252], [181, 294]]);
  });

  it('recalculates the descent guide only when the board or exact claw position changes', async () => {
    await mount(); const current = scene(); current.mode = 'ready';
    const plan = vi.spyOn(physics, 'planDescent');
    renderer!.draw(0, current); renderer!.draw(16, current); renderer!.draw(32, current);
    expect(plan).toHaveBeenCalledTimes(1);
    current.claw.x += .000001;
    renderer!.draw(48, current);
    expect(plan).toHaveBeenCalledTimes(2);
    current.board = current.board!.map(doll => ({ ...doll }));
    renderer!.draw(64, current);
    expect(plan).toHaveBeenCalledTimes(3);
  });

  it('redraws a newly loaded sprite and ignores late image/resize callbacks after destruction', async () => {
    const { invalidate } = await mount(), current = scene();
    renderer!.draw(0, current);
    const allocated = surfaces.length, loaded = sprites[0].onload!;
    loaded();
    expect(invalidate).toHaveBeenCalledTimes(1);
    renderer!.draw(16, current);
    expect(surfaces.length).toBe(allocated + 1);
    renderer!.destroy();
    invalidate.mockClear();
    loaded(); resizeCallback(); renderer!.draw(32, current);
    expect(invalidate).not.toHaveBeenCalled();
    expect(sprites.every(sprite => sprite.onload === null && sprite.onerror === null)).toBe(true);
    expect(surfaces.slice(1).every(layer => layer.width === 0 && layer.height === 0)).toBe(true);
    renderer = undefined;
  });
});
