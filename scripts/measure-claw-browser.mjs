// Measure the real built claw UI with the same deterministic local API client.
// Run an app build at --url and an isolated scripts/e2e-server.mjs at --fixture-url.
import { chromium, request } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = option('--url', 'http://localhost:8788');
const fixtureUrl = option('--fixture-url', url);
const sourceRoot = resolve(option('--root', '.'));
const output = option('--output', '/tmp/claw-browser.json');
const bootstrapDelayMs = Number(option('--bootstrap-delay', '0'));
const traceOutput = option('--trace', null);
const physicsArtifact = await build({ entryPoints: [resolve(sourceRoot, 'shared/claw-physics.ts')], bundle: true, format: 'esm', write: false });
const rulesArtifact = await build({ entryPoints: [resolve(sourceRoot, 'shared/balance.ts')], bundle: true, format: 'esm', write: false });
const loadArtifact = artifact => import(`data:text/javascript;base64,${Buffer.from(artifact.outputFiles[0].text).toString('base64')}`);
const physics = await loadArtifact(physicsArtifact), { CLAW_RULES } = await loadArtifact(rulesArtifact);
const fixture = await request.newContext({ baseURL: fixtureUrl });
let bootstrap;
try {
  const login = await fixture.post('/api/auth/login', { headers: { Origin: fixtureUrl, 'CF-Connecting-IP': '192.0.2.29' }, data: { username: 'min', password: 'e2e-only-password-2026' } });
  if (login.status() !== 200) throw new Error(`Local measurement fixture login: ${login.status()}`);
  // No notices in the fixture: a toast appearing or expiring mid-measurement is
  // a render of its own and would be counted against the claw machine.
  bootstrap = { ...await (await fixture.get('/api/bootstrap')).json(), notifications: { unread: 0, recent: [] } };
} finally { await fixture.dispose(); }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
let measuredPage = null;
const browserErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 3, reducedMotion: 'no-preference', serviceWorkers: 'block' });
  const page = await context.newPage();
  measuredPage = page;
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.addInitScript(() => {
    const metrics = window.__clawMeasure = { phase: null, phases: {}, longTasks: [], responseAt: null, playingAt: null, firstPlayingPaint: null, runtime: null };
    let renderer = 0, lastRAF = 0;
    const scan = fiber => {
      if (!fiber || metrics.runtime) return;
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const value = hook.memoizedState?.current;
        if (value && typeof value.primary === 'function' && typeof value.press === 'function' && typeof value.releaseAll === 'function') { metrics.runtime = value; break; }
      }
      for (let child = fiber.child; child && !metrics.runtime; child = child.sibling) scan(child);
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), inject(value) { this.renderers.set(++renderer, value); return renderer; },
      onCommitFiberRoot(_id, root) { const phase = metrics.phases[metrics.phase]; if (phase) phase.reactCommits++; scan(root.current); },
      onCommitFiberUnmount() {}, checkDCE() {},
    };
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => raf.call(window, time => { lastRAF = time; callback(time); });
    // Resolve the main canvas once per context. The observer must not add a
    // DOM selector walk and a temporary argument array to every doll draw.
    const mainContexts = new WeakMap();
    const isMain = context => {
      const known = mainContexts.get(context);
      if (known !== undefined) return known;
      const main = context.canvas instanceof HTMLCanvasElement && Boolean(context.canvas.closest('.claw-glass'));
      mainContexts.set(context, main);
      return main;
    };
    const paint = (context, method) => {
      if (!isMain(context)) return;
      const phase = metrics.phases[metrics.phase];
      if (!phase) return;
      phase[method]++;
      if (phase.paintTimes[phase.paintTimes.length - 1] !== lastRAF) phase.paintTimes.push(lastRAF);
      if (metrics.responseAt !== null && metrics.firstPlayingPaint === null && metrics.runtime?.mode === 'playing') metrics.firstPlayingPaint = performance.now();
    };
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
      paint(this, 'clearRect');
      return clearRect.call(this, x, y, width, height);
    };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, a, b, c, d, e, f, g, h) {
      paint(this, 'drawImage');
      if (arguments.length === 3) return drawImage.call(this, source, a, b);
      if (arguments.length === 5) return drawImage.call(this, source, a, b, c, d);
      if (arguments.length === 9) return drawImage.call(this, source, a, b, c, d, e, f, g, h);
      return Reflect.apply(drawImage, this, arguments);
    };
    const shadow = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'shadowBlur');
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', { ...shadow, set(value) {
      const phase = metrics.phases[metrics.phase];
      if (phase && isMain(this)) phase.shadowBlur++;
      shadow.set.call(this, value);
    } });
    const fetch = window.fetch;
    window.fetch = async (...values) => {
      const response = await Reflect.apply(fetch, window, values);
      if (new URL(typeof values[0] === 'string' ? values[0] : values[0].url, location.href).pathname === '/api/claw/play') {
        const json = response.json.bind(response);
        response.json = async () => { const value = await json(); metrics.responseAt = performance.now(); performance.mark('pr5-play-response'); return value; };
      }
      return response;
    };
    new PerformanceObserver(list => { for (const task of list.getEntries()) metrics.longTasks.push({ startTime: task.startTime, duration: task.duration }); }).observe({ type: 'longtask' });
    const observer = new MutationObserver(() => {
      if (metrics.responseAt !== null && metrics.playingAt === null && document.querySelector('.claw-cabinet')?.dataset.state === 'playing') metrics.playingAt = performance.now();
    });
    observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    metrics.start = name => { metrics.phase = name; metrics.phases[name] = { start: performance.now(), reactCommits: 0, clearRect: 0, drawImage: 0, shadowBlur: 0, paintTimes: [] }; performance.mark(`pr5-${name}-start`); };
    metrics.finish = () => { const phase = metrics.phases[metrics.phase]; phase.end = performance.now(); metrics.phase = null; };
  });
  const now = Date.parse(bootstrap.serverTime);
  let state = { coins: 5, freeCoins: 5, purchasedCoins: 0, nextGrantAt: now + 10800000, serverNow: now, isAdmin: false,
    board: physics.createBoard(1, 1792405194), generation: 1, version: 0, nextPlayAt: 0 };
  let played = false;
  const apiRequests = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    apiRequests.push({ path, method: route.request().method() });
    if (path === '/api/bootstrap') {
      if (played && bootstrapDelayMs) await new Promise(resolve => setTimeout(resolve, bootstrapDelayMs));
      return route.fulfill({ json: { ...bootstrap, claw: state,
        user: { ...bootstrap.user, gold: bootstrap.user.gold + (state.result?.gold ?? 0), weeklyScore: bootstrap.user.weeklyScore + (state.result?.points ?? 0) },
        players: bootstrap.players.map(player => player.id === bootstrap.user.id ? { ...player, weeklyScore: player.weeklyScore + (state.result?.points ?? 0) } : player) } });
    }
    if (path === '/api/claw' && route.request().method() === 'GET') return route.fulfill({ json: state });
    if (path === '/api/claw/play') {
      const input = route.request().postDataJSON();
      const sim = physics.simulateAttempt(state.board, { x: input.x, stop: input.stop, pickup: 1, carry: 1 });
      const result = { requestId: input.requestId, playId: 'measured-play', engine: CLAW_RULES.engine, x: input.x, stop: input.stop ?? null,
        grip: { pickup: 1, carry: 1, strong: true }, caught: Boolean(sim.prizes.length), prizes: sim.prizes, doll: sim.prizes[0] ?? null,
        target: sim.target, points: sim.prizes.length * CLAW_RULES.dollScore, gold: sim.prizes.length * CLAW_RULES.dollGold,
        clearBonus: 0, clearGold: 0, cleared: false, released: sim.released, reason: sim.reason };
      state = { ...state, board: sim.board, coins: 4, freeCoins: 4, version: 1, result };
      played = true;
      return route.fulfill({ json: state });
    }
    return route.abort();
  });
  const moduleUrl = new URL('/__claw-measured-physics.js', url).href;
  await page.route('**/__claw-measured-physics.js', route => route.fulfill({ contentType: 'application/javascript', body: physicsArtifact.outputFiles[0].text }));
  await page.goto(`${url}/#/play/claw`);
  await page.getByRole('button', { name: '코인 넣기', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.claw-drop').disabled && window.__clawMeasure.runtime);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))));
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
  await page.waitForTimeout(1200); // Let DOM clock labels and all entry effects settle.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const traceEvents = [];
  if (traceOutput) {
    cdp.on('Tracing.dataCollected', data => traceEvents.push(...data.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  }
  await page.evaluate(() => window.__clawMeasure.start('idle'));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__clawMeasure.finish());
  await page.getByRole('button', { name: '코인 넣기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.claw-cabinet')?.dataset.state === 'ready');
  await page.evaluate(() => window.__clawMeasure.start('control'));
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(1200); await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(600); await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__clawMeasure.finish());
  await page.evaluate(() => window.__clawMeasure.start('replayStartup'));
  await page.getByRole('button', { name: '집게 내리기', exact: true }).click();
  await page.waitForFunction(() => window.__clawMeasure.firstPlayingPaint !== null, undefined, { timeout: 15000 });
  await page.evaluate(() => window.__clawMeasure.finish());
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 20000 });
  // Allow the original spring and result celebration to settle in both builds.
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.__clawMeasure.start('result'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__clawMeasure.finish());
  const measured = await page.evaluate(() => {
    const metrics = window.__clawMeasure;
    const phases = Object.fromEntries(Object.entries(metrics.phases).map(([key, value]) => {
      const frameMs = value.paintTimes.slice(1).map((time, index) => time - value.paintTimes[index]);
      return [key, { ...value, durationMs: value.end - value.start, reactCommitsPerSecond: value.reactCommits / ((value.end - value.start) / 1000),
        canvasPaints: value.paintTimes.length, frameMs, longTasks: metrics.longTasks.filter(task => task.startTime >= value.start && task.startTime < value.end) }];
    }));
    const canvas = document.querySelector('.claw-glass canvas');
    return { phases, responseToPlayingMs: metrics.playingAt - metrics.responseAt, responseToFirstPaintMs: metrics.firstPlayingPaint - metrics.responseAt,
      soundMuted: metrics.runtime.sound.muted, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
      canvasContext: canvas.getContext('2d').getContextAttributes(),
      canvasPixels: [canvas.width, canvas.height], canvasCss: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height], devicePixelRatio };
  });
  if (traceOutput) {
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end'); await complete;
    await writeFile(traceOutput, JSON.stringify({ traceEvents }));
  }
  const simulation = await page.evaluate(async url => {
    const physics = await import(url), samples = [];
    for (const seed of [20261104, 12345, 42]) {
      const board = physics.createBoard(1, seed);
      for (const doll of [...board].sort((a, b) => a.y - b.y).slice(0, 8)) {
        const started = performance.now();
        const result = physics.simulateAttempt(board, { x: doll.x, pickup: 1, carry: 1 }, { record: true });
        samples.push({ seed, x: doll.x, durationMs: performance.now() - started, frames: result.frames.length, reason: result.reason });
      }
    }
    return samples;
  }, moduleUrl);
  const report = { measuredOn: '2026-11-04', browser: await browser.version(), cpuThrottle: 4, viewport: { width: 390, height: 900 }, deviceScaleFactor: 3,
    sourceRoot, harness: 'Main context classification cached in WeakMap; fixed-arity native canvas forwarding avoids per-draw rest arrays; Long Task observer and thresholds unchanged.',
    protocol: 'Built UI; all React root commits; settled fonts/images; no forced GC or Long Task filtering inside measured phases; 3s idle, real arrow key holds 1.2s right/0.6s left, result response to first replay canvas paint; fixed 5s result settling in both builds.',
    fixture: 'Test-only deterministic local API client, authentic bootstrap from isolated local D1, unchanged shared physics produces a saved strong result; board seed1792405194; no production test endpoint.',
    bootstrapDelayMs, apiRequests, browserErrors, ...measured, synchronousPhysicsSamples: simulation, result: state.result };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, idle: measured.phases.idle.reactCommits, controlLongTasks: measured.phases.control.longTasks, responseToFirstPaintMs: measured.responseToFirstPaintMs }));
} catch (error) {
  const state = measuredPage ? await measuredPage.evaluate(() => {
    const metrics = window.__clawMeasure, runtime = metrics?.runtime;
    return { phase: metrics?.phase, phases: metrics?.phases, longTasks: metrics?.longTasks,
      responseAt: metrics?.responseAt, firstPlayingPaint: metrics?.firstPlayingPaint,
      mode: runtime?.mode, frameId: runtime?.frameId, lastFrame: runtime?.lastFrame,
      replayIndex: runtime?.replay?.index, replayPlayhead: runtime?.replay?.playhead,
      replayLast: runtime?.replay?.last, replayFrames: runtime?.replay?.frames.length };
  }).catch(() => null) : null;
  await writeFile(`${output}.failure.json`, `${JSON.stringify({ error: String(error), browserErrors, state }, null, 2)}\n`);
  throw error;
} finally { await browser.close(); }
