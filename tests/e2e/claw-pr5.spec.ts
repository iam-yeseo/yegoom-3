import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { CLAW_RULES } from '../../shared/balance';
import { createBoard, simulateAttempt } from '../../shared/claw-physics';
import type { BootstrapResponse, ClawPlayInput, ClawResponse } from '../../shared/types';

test.use({ serviceWorkers: 'block' });
const run = promisify(execFile);
const machine = (page: Page) => page.locator('.claw-cabinet');
async function fixtureMachine(page: Page, holdBootstrap = false) {
  const login = await page.request.post('/api/auth/login', { headers: { Origin: 'http://localhost:8788', 'CF-Connecting-IP': '192.0.2.30' }, data: { username: 'min', password: 'e2e-only-password-2026' } });
  expect(login.status()).toBe(200);
  const bootstrap = await (await page.request.get('/api/bootstrap')).json() as BootstrapResponse;
  const now = Date.parse(bootstrap.serverTime);
  let state: ClawResponse = { coins: 5, freeCoins: 5, purchasedCoins: 0, nextGrantAt: now + CLAW_RULES.coinIntervalMs,
    serverNow: now, isAdmin: false, board: createBoard(1, 1792405194), generation: 1, version: 0, nextPlayAt: 0 };
  let played = false, held = false;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/bootstrap', async route => {
    if (played && holdBootstrap) { held = true; await gate; }
    return route.fulfill({ json: { ...bootstrap, announcements: [], claw: state,
      user: { ...bootstrap.user, gold: bootstrap.user.gold + (state.result?.gold ?? 0), weeklyScore: bootstrap.user.weeklyScore + (state.result?.points ?? 0) },
      players: bootstrap.players.map(player => player.id === bootstrap.user.id ? { ...player, weeklyScore: player.weeklyScore + (state.result?.points ?? 0) } : player) } });
  });
  await page.route('**/api/claw', route => route.fulfill({ json: state }));
  await page.route('**/api/claw/play', route => {
    const input = route.request().postDataJSON() as ClawPlayInput;
    const sim = simulateAttempt(state.board, { x: input.x, stop: input.stop, pickup: 1, carry: 1 });
    state = { ...state, coins: 4, freeCoins: 4, version: state.version + 1, board: sim.board,
      result: { requestId: input.requestId, playId: `fixture-${input.requestId}`, engine: CLAW_RULES.engine, x: input.x, stop: input.stop ?? null,
        grip: { pickup: 1, carry: 1, strong: true }, caught: sim.prizes.length > 0, prizes: sim.prizes, doll: sim.prizes[0] ?? null,
        target: sim.target, points: sim.prizes.length * CLAW_RULES.dollScore, gold: sim.prizes.length * CLAW_RULES.dollGold,
        clearBonus: 0, clearGold: 0, cleared: false, released: sim.released, reason: sim.reason } };
    played = true;
    return route.fulfill({ json: state });
  });
  await page.goto('/#/play/claw');
  await expect(page.getByRole('button', { name: '코인 넣기', exact: true })).toBeEnabled();
  await expect(machine(page)).toHaveAttribute('data-state', 'idle');
  // The frozen server date differs from the browser date. The first loaded
  // clock label must already use the server offset, before its one-second tick.
  expect(await page.locator('.claw-wallet-detail small').textContent()).toContain('다음 충전까지');
  return { release, held: () => held };
}
async function capture(page: Page, name: string, info: TestInfo) {
  await expect(page.locator('.claw-wallet-detail small')).toContainText('다음 충전까지');
  await expect(page.locator('.fx-toast')).toHaveCount(0);
  for (let index = 0; index < 5 && await page.locator('.announcement-banner').count(); index++) await page.locator('.announcement-banner').click();
  await expect(page.locator('.announcement-banner')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))));
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
  await page.evaluate(() => scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/update-pr5-${name}.png`;
  await page.screenshot({ path, fullPage: name !== 'low-height-390x700' });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function fullWidth(page: Page) {
  const boxes = await page.locator('.claw-wallet, .claw-cabinet, .claw-guide').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(1);
  const dimensions = await page.locator('.claw-glass canvas').evaluate((node: HTMLCanvasElement) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, pixels: node.width }));
  expect(dimensions.width / dimensions.height).toBeCloseTo(600 / 420, 2);
  expect(dimensions.pixels).toBeLessThanOrEqual(Math.ceil(dimensions.width * 2));
  if (page.viewportSize()!.width === 560) expect(boxes[0]).toBeGreaterThan(480);
}
for (const width of [390, 560]) test(`claw uses the full app width for idle, controls and result at ${width}px`, async ({ page }, info) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixtureMachine(page);
  await fullWidth(page);
  await capture(page, `idle-${width}`, info);
  await page.getByRole('button', { name: '코인 넣기', exact: true }).click();
  await expect(machine(page)).toHaveAttribute('data-state', 'ready');
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(500); await page.keyboard.up('ArrowRight');
  await capture(page, `control-${width}`, info);
  await page.getByRole('button', { name: '집게 내리기', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });
  await capture(page, `result-${width}`, info);
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(machine(page)).toHaveAttribute('data-state', 'idle');
});

test('short 390 by 700 viewport keeps all enabled machine controls above the tab bar', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixtureMachine(page);
  await page.getByRole('button', { name: '코인 넣기', exact: true }).click();
  await fullWidth(page);
  const bounds = await page.locator('.claw-console').evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, top: node.getBoundingClientRect().top,
    limit: document.querySelector('.tabbar')?.getBoundingClientRect().top ?? innerHeight }));
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.limit);
  await expect(page.getByRole('button', { name: '집게 내리기', exact: true })).toBeEnabled();
  await capture(page, 'low-height-390x700', info);
});

test('a saved claw response begins replay while the subsequent balance bootstrap is still pending', async ({ page }) => {
  const fixture = await fixtureMachine(page, true);
  try {
    await page.getByRole('button', { name: '코인 넣기', exact: true }).click();
    await page.getByRole('button', { name: '집게 내리기', exact: true }).click();
    await expect.poll(fixture.held).toBe(true);
    await expect(machine(page)).toHaveAttribute('data-state', 'playing');
  } finally { fixture.release(); }
});

test('player and administrator preview share the wider machine and capped DPR without server requests', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/play/claw');
  await expect(page.getByRole('button', { name: '코인 넣기', exact: true })).toBeEnabled();
  await fullWidth(page);
  await page.goto('/#/preview/admin');
  await expect(page.getByText('운영 화면 미리보기', { exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = '/preview/play/claw'; });
  await expect(page.getByRole('button', { name: '테스트 시작', exact: true })).toBeEnabled();
  await fullWidth(page);
  await page.getByRole('button', { name: '테스트 시작', exact: true }).click();
  await expect(machine(page)).toHaveAttribute('data-state', 'ready');
  expect(requests).toEqual([]);
});

test('claw idle commits, moving frames and first replay paint meet the fourfold CPU budget', async ({}, info) => {
  test.setTimeout(90000);
  const output = info.outputPath('claw-browser-metrics.json');
  await run(process.execPath, ['scripts/measure-claw-browser.mjs', '--url', 'http://localhost:8788', '--output', output],
    { cwd: process.cwd(), env: { ...process.env, CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/usr/bin/chromium' } });
  const report = JSON.parse(await readFile(output, 'utf8'));
  expect(report.cpuThrottle).toBe(4);
  expect(report.deviceScaleFactor).toBe(3);
  expect(report.phases.idle.reactCommits).toBe(0);
  expect(report.phases.idle.canvasPaints).toBe(0);
  expect(report.phases.result.reactCommits).toBe(0);
  expect(report.phases.result.canvasPaints).toBe(0);
  expect(report.phases.control.shadowBlur).toBe(0);
  // The counts above are machine-independent: idle and result frames either
  // render or they do not. The two numbers below are wall-clock on a fourfold
  // throttle, and the same build measures 75-160ms on a shared CI runner, so
  // their ceilings catch a real regression (a doubled first paint, a stalled
  // frame) instead of a slow runner. The raw numbers are attached either way.
  expect((report.phases.control.longTasks as { duration: number }[]).filter(task => task.duration > 120)).toEqual([]);
  expect(report.responseToFirstPaintMs).toBeLessThanOrEqual(250);
  await info.attach('claw-fourfold-cpu', { path: output, contentType: 'application/json' });
});
