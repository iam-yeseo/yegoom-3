import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse, ClawPlayInput, ClawResponse } from '../../shared/types';

const NOW = '2026-10-30T00:00:00Z';
const machine = (page: Page) => page.locator('.claw-cabinet');
const canvas = (page: Page) => page.locator('.claw-glass canvas');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

// Run real RAF callbacks under a controlled clock: skipped frames would hide
// movement, descent and replay bugs because the original physics caps dt.
test.beforeEach(async ({ page }) => {
  // A separate local client IP keeps this file independent of the previous
  // suite's 30-logins-per-15-minutes bucket under the frozen Worker clock.
  // The real rate limit and all authentication checks remain enabled.
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.6' });
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.pauseAt(new Date('2026-10-30T00:00:01Z'));
  await page.setViewportSize({ width: 390, height: 900 });
});
async function waitForMachineScreen(page: Page) {
  // A reload starts a new lazy import, including when a failed API read or
  // cooldown means the play button cannot become enabled.
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return machine(page).count();
  }, { intervals: [50] }).toBe(1);
}
async function waitForMachine(page: Page, name = '코인 넣기') {
  // React's lazy-screen retry runs on a timer; keep the controlled clock moving
  // until the downloaded module has committed, before measuring game physics.
  await expect.poll(async () => {
    await page.clock.runFor(50);
    const target = button(page, name);
    return await target.count() > 0 && await target.isEnabled();
  }, { intervals: [50] }).toBe(true);
}
async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await button(page, '예굼방 들어가기').click({ force: true });
  await expect(page.getByRole('heading', { name: `${username}님`, exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = '/play/claw'; });
  await waitForMachine(page);
  await expect(canvas(page)).toHaveAccessibleName(/인형 30개/);
  await page.clock.runFor(64);
}
async function bootstrap(page: Page): Promise<BootstrapResponse> {
  const response = await page.request.get('/api/bootstrap');
  expect(response.status()).toBe(200);
  return response.json();
}
async function readClaw(page: Page): Promise<ClawResponse> {
  const response = await page.request.get('/api/claw');
  expect(response.status()).toBe(200);
  return response.json();
}
async function checkCanvasBuffer(page: Page) {
  const dimensions = await canvas(page).evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height, cssWidth: bounds.width, cssHeight: bounds.height, dpr: devicePixelRatio };
  });
  expect(dimensions.width).toBe(Math.round(dimensions.cssWidth * Math.min(dimensions.dpr, 3)));
  expect(dimensions.height).toBe(Math.round(dimensions.cssHeight * Math.min(dimensions.dpr, 3)));
  return dimensions;
}
async function captures(page: Page, mode: 'authenticated' | 'preview', state: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  const originalViewport = page.viewportSize()!;
  if (['success', 'failure', 'result'].includes(state)) {
    const dialog = page.getByRole('dialog');
    await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    await expect(dialog).toHaveCSS('opacity', '1');
  }
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(32);
    // ResizeObserver can clear the backing buffer after a paused RAF. Wait
    // for an actual opaque draw at stable dimensions before taking the shot.
    let previousSize = '';
    let painted = 0;
    await expect.poll(async () => {
      await page.clock.runFor(16);
      const sample = await canvas(page).evaluate(element => {
        const target = element as HTMLCanvasElement;
        return { size: `${target.width}x${target.height}`, alpha: target.getContext('2d')!.getImageData(10, 10, 1, 1).data[3] };
      });
      painted = sample.alpha === 255 && sample.size === previousSize ? painted + 1 : 0;
      previousSize = sample.size;
      return painted;
    }, { intervals: [50] }).toBeGreaterThanOrEqual(1);
    if (state === 'prize-chute') {
      // Capture the lit half of the real chute blink, without altering styles.
      while (await page.evaluate(() => Math.floor(performance.now() / 120) % 2 !== 0)) await page.clock.runFor(16);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await checkCanvasBuffer(page);
    const file = `docs/screenshots/v3-claw-${mode}-${state}-${width}.png`;
    await page.screenshot({ path: file, fullPage: !['success', 'failure', 'result'].includes(state) });
    await info.attach(`${mode}-${state}-${width}`, { path: file, contentType: 'image/png' });
  }
  await page.setViewportSize(originalViewport);
  await page.clock.runFor(16);
}
async function moveToMiddle(page: Page, input: 'pointer' | 'keyboard') {
  await button(page, '코인 넣기').click({ force: true });
  await expect(machine(page)).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('timer')).toContainText('10');
  const right = button(page, '집게 오른쪽으로 이동');
  if (input === 'pointer') {
    const rect = await right.boundingBox();
    await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await page.mouse.down();
  } else await page.keyboard.down('ArrowRight');
  await expect(right).toHaveClass(/is-held/);
  await page.clock.runFor(800);
  if (input === 'pointer') await page.mouse.up();
  else await page.keyboard.up('ArrowRight');
  await expect(right).not.toHaveClass(/is-held/);
  await page.clock.runFor(512);
  await expect(canvas(page)).toHaveAccessibleName(/위치는 왼쪽에서 50퍼센트/);
  // The canvas and console are excluded from the global touch/press effect.
  await expect(page.locator('.fx-touch-effect')).toHaveCount(0);
}
async function stopDescent(page: Page, milliseconds = 288) {
  await button(page, '집게 내리기').click({ force: true });
  await expect(machine(page)).toHaveAttribute('data-state', 'descending');
  await page.clock.runFor(milliseconds);
  await button(page, '멈추기').click({ force: true });
  await page.clock.runFor(16);
}
async function advanceUntil(page: Page, predicate: () => Promise<boolean>, limit = 8000) {
  for (let elapsed = 0; elapsed <= limit; elapsed += 64) {
    if (await predicate()) return elapsed;
    await page.clock.runFor(64);
  }
  throw new Error(`Claw replay did not reach the expected visible state within ${limit}ms`);
}
async function finishReplay(page: Page) {
  await advanceUntil(page, async () => await machine(page).getAttribute('data-state') === 'result');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).not.toContainText('재생을 확인하지 못해');
}

test('real claw pointer controls replay the server catch, update rewards, and buy persistent coins', async ({ page }, info) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const warnings: string[] = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await login(page, 'min');
  const before = await bootstrap(page);
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 5개 · 구매 0개');
  await captures(page, 'authenticated', 'idle', info);
  await page.setViewportSize({ width: 390, height: 900 });
  await moveToMiddle(page, 'pointer');
  await captures(page, 'authenticated', 'controls', info);
  const response = page.waitForResponse(value => value.url().endsWith('/api/claw/play') && value.request().method() === 'POST');
  await stopDescent(page);
  const receipt: ClawResponse = await (await response).json();
  expect(receipt.result).toMatchObject({ caught: true, points: 1, gold: 10, grip: { strong: true } });
  expect(receipt.result!.prizes.map(doll => doll.id)).toEqual(['1-24']);
  expect(receipt.result!.x).toBeGreaterThanOrEqual(.495);
  expect(receipt.result!.x).toBeLessThanOrEqual(.505);
  expect(receipt.result!.stop).toBeGreaterThanOrEqual(115);
  expect(receipt.result!.stop).toBeLessThanOrEqual(132);
  expect(receipt.board).toHaveLength(29);
  expect(receipt.freeCoins).toBe(4);
  await expect(machine(page)).toHaveAttribute('data-state', 'playing');
  await advanceUntil(page, () => machine(page).evaluate(element => element.classList.contains('is-celebrating')));
  await expect(page.locator('.claw-status')).toContainText('배출구로 쏙');
  await captures(page, 'authenticated', 'prize-chute', info);
  await finishReplay(page);
  await expect(page.getByRole('dialog', { name: '인형 뽑기 성공!' })).toBeVisible();
  await expect(page.locator('.claw-result-rewards')).toHaveText('+1점+10G');
  await captures(page, 'authenticated', 'success', info);
  expect(warnings.filter(message => message.includes('재생'))).toEqual([]);
  await button(page, '확인').click({ force: true });
  await expect(machine(page)).toHaveAttribute('data-state', 'idle');
  const after = await bootstrap(page);
  expect(after.user.gold).toBe(before.user.gold + 10);
  expect(after.user.weeklyScore).toBe(before.user.weeklyScore + 1);
  expect(after.ledger.filter(row => row.reason === '캐릭터 뽑기 인형 획득').map(row => [row.currency, row.amount]).sort()).toEqual([['gold', 10], ['score', 1]]);
  await expect(page.locator('.game-toolbar .gold')).toContainText(after.user.gold.toLocaleString('ko-KR'));

  // Commit succeeds, but the following balance refresh fails. A later read
  // must repair the header without replaying the purchase or charging twice.
  let failedRefresh = false;
  await page.route('**/api/bootstrap', async route => {
    if (!failedRefresh) { failedRefresh = true; await route.abort('failed'); }
    else await route.continue();
  });
  await button(page, '코인 1개 사기 · 100G').click({ force: true });
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 4개 · 구매 1개');
  expect(failedRefresh).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.game-toolbar .gold')).toContainText((after.user.gold - 100).toLocaleString('ko-KR'));
  await page.unroute('**/api/bootstrap');
  await button(page, '코인 5개 사기 · 500G').click({ force: true });
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 4개 · 구매 6개');
  await page.clock.runFor(3000);
  await captures(page, 'authenticated', 'coin-purchase', info);
  const bought = await bootstrap(page);
  expect(bought.user.gold).toBe(after.user.gold - 600);
  expect(bought.ledger.filter(row => row.reason === '뽑기 코인 구매').map(row => row.amount).sort((a, b) => a - b)).toEqual([-500, -100]);
  await page.reload();
  await waitForMachineScreen(page);
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 4개 · 구매 6개');
  await expect(canvas(page)).toHaveAccessibleName(/인형 29개/);
  await page.evaluate(() => { location.hash = '/'; });
  await expect(page.locator('.solo-tile').filter({ hasText: '캐릭터 뽑기' })).toContainText('코인 10개');
  await info.attach('single-catch-server-receipt', { body: JSON.stringify(receipt, null, 2), contentType: 'application/json' });
});

test('real claw keyboard play recovers a lost response after reload and a failed entry read, once', async ({ page }, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 560, height: 900 });
  await login(page, 'siwon');
  const before = await bootstrap(page);
  const requests: ClawPlayInput[] = [];
  let committed: ClawResponse | undefined;
  await page.route('**/api/claw/play', async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed = await response.json();
      await route.abort('failed');
    } else await route.continue();
  });
  await moveToMiddle(page, 'keyboard');
  await stopDescent(page);
  await expect(button(page, '결과 확인')).toBeEnabled();
  expect(committed!.result!.prizes.map(doll => doll.id)).toEqual(['7-24', '7-29']);
  expect(committed!.freeCoins).toBe(4);
  await page.route('**/api/claw', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '브라우저 테스트: 기계 읽기 연결 중단' }) }));
  await page.reload();
  await waitForMachineScreen(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(button(page, '결과 확인')).toBeEnabled();
  const replayResponse = page.waitForResponse(value => value.url().endsWith('/api/claw/play') && value.status() === 200);
  await button(page, '결과 확인').click({ force: true });
  const replay: ClawResponse = await (await replayResponse).json();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(replay).toMatchObject({ replayed: true, freeCoins: 4, version: 1, result: { points: 2, gold: 20 } });
  await expect(machine(page)).toHaveAttribute('data-state', 'playing');
  await finishReplay(page);
  await expect(page.getByRole('dialog', { name: '한 번에 2개!' })).toBeVisible();
  await expect(page.locator('.claw-result-art img')).toHaveCount(2);
  await expect(page.locator('.claw-result-rewards')).toHaveText('+2점+20G');
  const after = await bootstrap(page);
  expect(after.user.gold).toBe(before.user.gold + 20);
  expect(after.user.weeklyScore).toBe(before.user.weeklyScore + 2);
  expect(after.ledger.filter(row => row.reason === '캐릭터 뽑기 인형 획득')).toHaveLength(2);
  await page.unroute('**/api/claw');
  await button(page, '확인').click({ force: true });
  await expect(canvas(page)).toHaveAccessibleName(/인형 28개/);
  await page.reload();
  await waitForMachineScreen(page);
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 4개');
  await expect(button(page, '결과 확인')).toHaveCount(0);
  expect((await readClaw(page)).freeCoins).toBe(4);
  await info.attach('lost-response-recovery', { body: JSON.stringify({ requests, committed, replay }, null, 2), contentType: 'application/json' });
});

test('real claw early stop fails without a reward and reduced motion shortens replay', async ({ page }, info) => {
  test.setTimeout(60000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'yeseo');
  const before = await bootstrap(page);
  await button(page, '코인 넣기').click({ force: true });
  const response = page.waitForResponse(value => value.url().endsWith('/api/claw/play'));
  await stopDescent(page, 32);
  const receipt: ClawResponse = await (await response).json();
  expect(receipt.result).toMatchObject({ caught: false, points: 0, gold: 0, prizes: [], reason: 'miss' });
  expect(receipt.result!.stop).toBeLessThan(70);
  await expect(machine(page)).toHaveAttribute('data-state', 'playing');
  const replayDuration = await advanceUntil(page, async () => await machine(page).getAttribute('data-state') === 'result');
  expect(replayDuration).toBeLessThan(2500);
  await expect(page.getByRole('dialog', { name: '조금만 더 가까이!' })).toBeVisible();
  await expect(page.locator('.claw-result-confetti')).toHaveCount(0);
  await expect(machine(page)).not.toHaveClass(/is-celebrating/);
  await expect(page.locator('.claw-result-art img')).not.toHaveAttribute('src', /sprites/);
  expect(await page.locator('.claw-bulbs i').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).animationName === 'none'))).toBe(true);
  await captures(page, 'authenticated', 'failure', info);
  const after = await bootstrap(page);
  expect(after.user.gold).toBe(before.user.gold);
  expect(after.user.weeklyScore).toBe(before.user.weeklyScore);
  expect(after.ledger.filter(row => row.reason === '캐릭터 뽑기 인형 획득')).toHaveLength(0);
  expect(receipt.freeCoins).toBe(4);
  await info.attach('reduced-motion-failure', { body: JSON.stringify({ replayDuration, receipt }, null, 2), contentType: 'application/json' });
});

test('claw preview stays serverless, preserves sound preference, and auto-drops after ten seconds', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(90000);
  const apiRequests: string[] = [];
  await page.route('**/api/**', route => { apiRequests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview/play/claw');
  await waitForMachine(page);
  await expect(button(page, '소리 켜짐')).toHaveAttribute('aria-pressed', 'true');
  await button(page, '소리 켜짐').click({ force: true });
  await page.reload();
  await waitForMachine(page);
  await expect(button(page, '소리 꺼짐')).toHaveAttribute('aria-pressed', 'false');
  await page.clock.runFor(500);
  await captures(page, 'preview', 'idle', info);
  await page.setViewportSize({ width: 560, height: 900 });
  const beforeGold = Number((await page.locator('.game-toolbar .gold').innerText()).replace(/\D/g, ''));
  await button(page, '코인 1개 사기 · 100G').click({ force: true });
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 5개 · 구매 1개');
  await expect(page.locator('.game-toolbar .gold')).toContainText((beforeGold - 100).toLocaleString('ko-KR'));
  // Space from the page itself, then a held left key, exercises the keyboard
  // path independently of clicking the console's primary button.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await expect(machine(page)).toHaveAttribute('data-state', 'ready');
  const insertedAt = await page.evaluate(() => performance.now());
  await page.keyboard.down('ArrowLeft');
  await page.clock.runFor(600);
  await page.keyboard.up('ArrowLeft');
  await expect(canvas(page)).toHaveAccessibleName(/위치는 왼쪽에서 5퍼센트/);
  // The deadline is relative to insertion, while RAF may start at any offset.
  // Stay safely before it, then run through two frames after the deadline.
  const untilLastTenth = insertedAt + 9900 - await page.evaluate(() => performance.now());
  await page.clock.runFor(untilLastTenth);
  await expect(machine(page)).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('timer')).toContainText('01');
  await page.clock.runFor(132);
  await expect(machine(page)).toHaveAttribute('data-state', 'descending');
  const elapsed = await page.evaluate(() => performance.now()) - insertedAt;
  expect(elapsed).toBeGreaterThanOrEqual(10000);
  expect(elapsed).toBeLessThanOrEqual(10032);
  // Stop above the dolls so the result is deterministic for any preview board.
  await page.keyboard.press('Space');
  await page.clock.runFor(16);
  await expect(machine(page)).toHaveAttribute('data-state', 'playing');
  await finishReplay(page);
  await expect(page.getByRole('dialog', { name: '조금만 더 가까이!' })).toBeVisible();
  await captures(page, 'preview', 'result', info);
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 4개 · 구매 1개');
  expect(apiRequests).toEqual([]);
  await button(page, '확인').click({ force: true });
  await page.evaluate(() => { location.hash = '/preview'; });
  await expect(page.locator('.solo-tile').filter({ hasText: '캐릭터 뽑기' })).toContainText('코인 5개');
  await page.reload();
  await page.evaluate(() => { location.hash = '/preview/play/claw'; });
  await waitForMachine(page);
  await expect(page.getByRole('region', { name: '내 코인' })).toContainText('무료 5개 · 구매 0개');
  await expect(button(page, '소리 꺼짐')).toBeVisible();
  expect(apiRequests).toEqual([]);
  const highDpr = await browser.newContext({ baseURL, viewport: { width: 390, height: 900 }, deviceScaleFactor: 4 });
  try {
    const sharp = await highDpr.newPage();
    sharp.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
    await sharp.goto('/#/preview/play/claw');
    await expect(button(sharp, '코인 넣기')).toBeEnabled();
    const dimensions = await checkCanvasBuffer(sharp);
    expect(dimensions.dpr).toBe(4);
    await sharp.evaluate(async () => { await navigator.serviceWorker.ready; });
    const dolls = await sharp.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
      (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat().filter(path => path.startsWith('/claw/dolls/')));
    expect(new Set(dolls).size).toBe(11);
    expect(apiRequests).toEqual([]);
    await info.attach('high-dpr-capped-canvas-and-precache', { body: JSON.stringify({ dimensions, dolls }, null, 2), contentType: 'application/json' });
  } finally { await highDpr.close(); }
});

test('claw reads on entry and visibility, never polls, and gives administrators unrewarded tests only', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill('admin');
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await button(page, '예굼방 들어가기').click({ force: true });
  await expect(page.getByRole('heading', { name: 'admin님', exact: true })).toBeVisible();
  let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/claw') reads++; });
  await page.evaluate(() => { location.hash = '/play/claw'; });
  await waitForMachine(page, '테스트 시작');
  await expect(page.getByRole('region', { name: '운영자 테스트' })).toContainText('무제한');
  await expect(button(page, '테스트 시작')).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: '이번 판 강집게로' })).toBeVisible();
  await expect(button(page, '코인 1개 사기 · 100G')).toHaveCount(0);
  expect(reads).toBe(1);
  await page.clock.runFor(16000);
  expect(reads).toBe(1);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => reads).toBe(2);
  const requestId = 'browser-claw-admin-request';
  const headers = { Origin: new URL(page.url()).origin };
  expect((await page.request.post('/api/claw/coins', { headers, data: { requestId, quantity: 1 } })).status()).toBe(403);
  const before = await bootstrap(page);
  const state = await readClaw(page);
  const played = await page.request.post('/api/claw/play', { headers, data: { requestId, version: state.version, x: .5, stop: null, forceStrong: true } });
  expect(played.status()).toBe(200);
  expect(await played.json()).toMatchObject({ coins: 0, result: { points: 0, gold: 0, clearBonus: 0, clearGold: 0, grip: { strong: true } } });
  const after = await bootstrap(page);
  expect(after.user.gold).toBe(before.user.gold); expect(after.user.weeklyScore).toBe(before.user.weeklyScore);
  expect(after.ledger).toEqual(before.ledger);
});
