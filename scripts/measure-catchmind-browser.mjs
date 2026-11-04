// Actual browser UI measurement. Serve a build from the selected root first.
// Example: node scripts/measure-catchmind-browser.mjs --url http://localhost:8794 --root ../yegoom-3-pr4-baseline --output /tmp/catchmind-before.json
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = option('--url', 'http://localhost:8794');
const sourceRoot = resolve(option('--root', '.'));
const output = option('--output', '/tmp/catchmind-browser.json');
const traceOutput = option('--trace', null);
const inputProtocol = option('--input', 'coalesced');
if (!['coalesced', 'burst'].includes(inputProtocol)) throw new Error('Expected --input coalesced or burst');
const fillArtifact = await build({ entryPoints: [resolve(sourceRoot, 'src/drawing.ts')], bundle: true, format: 'esm', write: false });
const fillModule = new URL('/__catchmind-measured-fill.js', url).href;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  const apiCalls = [];
  await page.route('**/api/**', route => { apiCalls.push(route.request().url()); return route.abort(); });
  // Serve the isolated real module through a test-only, same-origin interception
  // so the measurement also respects the production script-src 'self' policy.
  await page.route('**/__catchmind-measured-fill.js', route => route.fulfill({
    contentType: 'application/javascript', body: fillArtifact.outputFiles[0].text,
  }));
  await page.goto(`${url}/#/preview/play/catchmind`);
  await page.getByLabel('캐치마인드 정답', { exact: true }).fill('선인장');
  await page.getByRole('button', { name: '정답', exact: true }).click();
  await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
  const canvas = page.getByLabel('그림 그리는 캔버스', { exact: true });
  await canvas.waitFor({ state: 'visible' });
  await canvas.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  // Exclude first-page image decoding/entrance work from the drawing interval.
  // Both baseline and updated builds use this same settled-page protocol.
  await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))));
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const traceEvents = [];
  if (traceOutput) {
    cdp.on('Tracing.dataCollected', chunk => traceEvents.push(...chunk.value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(diagnostic => {
    const counts = { getImageData: 0, putImageData: 0, drawImage: 0, quadraticCurveTo: 0, stroke: 0 };
    window.__drawingMeasure = { counts, longTasks: [], active: false, expensiveCanvasCalls: [] };
    for (const method of Object.keys(counts)) {
      const original = CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method] = function (...args) {
        if (window.__drawingMeasure.active) counts[method]++;
        if (!diagnostic) return Reflect.apply(original, this, args);
        const start = performance.now();
        const result = Reflect.apply(original, this, args);
        const duration = performance.now() - start;
        if (window.__drawingMeasure.active && duration > 1) window.__drawingMeasure.expensiveCanvasCalls.push({ method, startTime: start, duration });
        return result;
      };
    }
    counts.createImageBitmap = 0;
    if (typeof window.createImageBitmap === 'function') {
      const original = window.createImageBitmap;
      window.createImageBitmap = function (...args) {
        if (window.__drawingMeasure.active) counts.createImageBitmap++;
        return Reflect.apply(original, window, args);
      };
    }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__drawingMeasure.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: false });
  }, Boolean(traceOutput));
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  // Collect startup garbage before either build's measured interval. No GC or
  // task filtering is performed during the stroke itself.
  await cdp.send('HeapProfiler.collectGarbage');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { window.__drawingMeasure.active = true; window.__drawingMeasure.start = performance.now(); performance.mark('pr4-stroke-start'); });
  await page.mouse.down();
  await page.evaluate(() => { window.__drawingMeasure.pointerDownComplete = performance.now(); performance.mark('pr4-pointerdown-complete'); });
  const frames = await page.evaluate(async protocol => {
    const node = document.querySelector('canvas[aria-label="그림 그리는 캔버스"]');
    const bounds = node.getBoundingClientRect();
    let sampled = 0, dispatched = 0;
    const durations = [];
    for (let frame = 0; frame < 180; frame++) {
      await new Promise(requestAnimationFrame);
      const start = performance.now();
      const samples = [];
      for (let sample = 0; sample < 8; sample++) {
        const index = sampled++;
        samples.push({ clientX: bounds.x + bounds.width * (.5 + .4 * Math.sin(index * .031)),
          clientY: bounds.y + bounds.height * (.5 + .4 * Math.sin(index * .047)) });
      }
      for (const point of protocol === 'burst' ? samples : [samples[samples.length - 1]]) {
        const event = new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, ...point });
        // Model the browser's one-per-frame pointermove with coalesced samples.
        // Both old and new handlers consume getCoalescedEvents(). The burst
        // mode separately stresses eight independent React events per frame.
        if (protocol === 'coalesced') Object.defineProperty(event, 'getCoalescedEvents', { value: () => samples });
        node.dispatchEvent(event); dispatched++;
      }
      durations.push(performance.now() - start);
    }
    return { sentPointerMoves: dispatched, sampledPoints: sampled, eventBatchDurations: durations };
  }, inputProtocol);
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const stroke = await page.evaluate(() => {
    const measure = window.__drawingMeasure;
    measure.end = performance.now(); measure.active = false;
    const tasks = measure.longTasks.filter(task => task.startTime >= measure.start && task.startTime < measure.end);
    performance.mark('pr4-stroke-end');
    return { durationMs: measure.end - measure.start, startTime: measure.start, pointerDownComplete: measure.pointerDownComplete,
      expensiveCanvasCalls: measure.expensiveCanvasCalls, canvasCalls: measure.counts, longTasks: tasks,
      longTaskCount: tasks.length, longestTaskMs: Math.max(0, ...tasks.map(task => task.duration)) };
  });
  if (traceOutput) {
    const completed = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end'); await completed;
    await writeFile(traceOutput, JSON.stringify({ traceEvents }));
  }
  const fill = await page.evaluate(async moduleUrl => {
    const { floodFill } = await import(moduleUrl);
    const samples = [];
    for (let index = 0; index < 6; index++) {
      const image = new ImageData(640, 640);
      image.data.fill(255);
      const started = performance.now();
      const changed = floodFill(image, 320, 320, [94, 106, 138, 255]);
      const duration = performance.now() - started;
      if (changed !== 640 * 640) throw new Error('Fill did not cover the whole connected region');
      if (index) samples.push(duration);
    }
    return { dimensions: [640, 640], samplesMs: samples, maximumMs: Math.max(...samples),
      medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] };
  }, fillModule);
  const contexts = await page.evaluate(() => ({
    base: document.querySelector('canvas[aria-label="그림 그리는 캔버스"]').getContext('2d').getContextAttributes(),
    overlay: document.querySelector('canvas.drawing-stroke-overlay')?.getContext('2d').getContextAttributes() ?? null,
  }));
  const result = { measuredOn: '2026-11-04', browser: await browser.version(), cpuThrottle: 4,
    setup: 'Fonts/images and finite animations settled; startup garbage collected before the measured stroke; no GC or task filtering during the stroke',
    sourceRoot, scope: 'Local Chromium, actual serverless DrawingCanvas UI; no remote API calls; module flood fill in same throttled browser',
    inputProtocol, viewport: { width: 390, height: 900 }, contexts, stroke: { ...stroke, ...frames }, fill, apiCalls };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, stroke: { durationMs: stroke.durationMs, longTaskCount: stroke.longTaskCount,
    longestTaskMs: stroke.longestTaskMs, canvasCalls: stroke.canvasCalls }, fill }));
} finally { await browser.close(); }
