import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse, LaunchGiftResponse } from '../../shared/types';

const LAUNCH_NOW = '2026-11-02T00:00:00Z'; // 09:00 KST on launch day.
const LAUNCH_ORIGIN = 'http://localhost:8789';
const STOCK_TITLE = '주식 시장은 준비 중이에요';
const GIFT_TITLE = '예굼방 아케이드 3 오픈 기념 선물';
const gift = (page: Page) => page.getByRole('dialog', { name: GIFT_TITLE, exact: true });
const stock = (page: Page) => page.getByRole('dialog', { name: STOCK_TITLE, exact: true });
let server: ChildProcess | undefined;
let serverLog: WriteStream | undefined;

async function stopServer() {
  const child = server;
  server = undefined;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already closed. */ }
    const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already closed. */ } }, 5000);
    await closed;
    clearTimeout(force);
  }
  serverLog?.end();
}
test.beforeAll(async ({}, info) => {
  info.setTimeout(120000);
  // Existing tests keep their October 30 server and fixtures. This separate
  // process compiles the same Worker at launch time into its own fresh D1.
  serverLog = createWriteStream(`/tmp/yegoom-launch-worker-${process.pid}.log`);
  server = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    detached: true,
    env: { ...process.env, E2E_PORT: '8789', E2E_NOW: LAUNCH_NOW },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.pipe(serverLog, { end: false });
  server.stderr!.pipe(serverLog, { end: false });
  try {
    await expect.poll(async () => {
      if (server!.exitCode !== null) throw new Error(`Launch fixture exited with ${server!.exitCode}`);
      try { return (await fetch(`${LAUNCH_ORIGIN}/api/health`)).ok; } catch { return false; }
    }, { timeout: 90000, intervals: [200, 500] }).toBe(true);
  } catch (error) { await stopServer(); throw error; }
});
test.afterAll(stopServer);
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(LAUNCH_NOW));
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.11' });
  await page.setViewportSize({ width: 390, height: 900 });
});
async function login(page: Page, username: string, origin = LAUNCH_ORIGIN) {
  await page.goto(`${origin}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
}
async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}
async function snapshot(page: Page): Promise<BootstrapResponse> {
  const response = await page.request.get(new URL('/api/bootstrap', page.url()).href);
  expect(response.status()).toBe(200);
  return response.json();
}
async function screenshot(page: Page, mode: 'authenticated' | 'preview', state: 'stock' | 'gift-before' | 'gift-after', width: number, info: TestInfo) {
  await page.setViewportSize({ width, height: 900 });
  const dialog = state === 'stock' ? stock(page) : gift(page);
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await dialog.evaluate(element => Promise.all(element.getAnimations({ subtree: true })
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  await expect(dialog).toHaveCSS('opacity', '1');
  await page.evaluate(() => scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
  if (state !== 'stock') {
    const tickets = await dialog.locator('.launch-gift-tickets > div').evaluateAll(cards => cards.map(card => {
      const bounds = card.getBoundingClientRect();
      const icon = card.querySelector('svg')!.getBoundingClientRect();
      return { iconHeight: icon.height, contained: [...card.children].every(child => {
        const box = child.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
      }) };
    }));
    expect(tickets).toEqual([{ iconHeight: 54, contained: true }, { iconHeight: 54, contained: true }]);
  }
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/launch-a-${mode}-${state}-${width}.png`;
  await page.screenshot({ path });
  await info.attach(`${mode}-${state}-${width}`, { path, contentType: 'image/png' });
}

test('stock entry points stay closed with accessible notices for real users until the market opens', async ({ page }, info) => {
  test.setTimeout(60000);
  await login(page, 'yeseo');
  // The serverless preview opens the sample market (tests/e2e/stock-pr10.spec.ts).
  for (const mode of ['authenticated'] as const) {
    const previewRequests: string[] = [];
    const prefix = '';
    const card = page.getByRole('button').filter({ hasText: '주식 시장' });
    await expect(card).toContainText('준비 중');
    await card.click();
    await expect(stock(page)).toContainText('곧 문을 열어요. 조금만 기다려 주세요!');
    expect(new URL(page.url()).hash).not.toContain('/stock');
    for (const width of [390, 560]) await screenshot(page, mode, 'stock', width, info);
    await stock(page).getByRole('button', { name: '확인', exact: true }).click();
    await expect(stock(page)).toHaveCount(0);
    await navigate(page, `${prefix}/games`);
    await expect(card).toContainText('준비 중');
    await card.click();
    await page.keyboard.press('Escape');
    await expect(stock(page)).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe(`#${prefix}/games`);
    await card.click();
    await stock(page).getByRole('button', { name: '닫기', exact: true }).click();
    await expect(stock(page)).toHaveCount(0);
    await card.click();
    await page.mouse.click(2, 2);
    await expect(stock(page)).toHaveCount(0);
    for (const path of [`${prefix}/stock`, `${prefix}/stock/YEGM`, `${prefix}/stock/news`]) {
      await page.goto(`${LAUNCH_ORIGIN}/#${path}`);
      await expect(stock(page)).toBeVisible();
      await expect.poll(() => new URL(page.url()).hash.includes('/stock')).toBe(false);
      await expect(page.locator('.room-name').filter({ hasText: 'yeseo님' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(previewRequests).toEqual([]);
  }
});

for (const [width, username, motion] of [[390, 'min', 'no-preference'], [560, 'siwon', 'reduce']] as const) {
  test(`real launch gift follows attendance, reopens until claimed, and grants five tickets once at ${width}px`, async ({ page }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: motion });
    await login(page, username);
    const before = await snapshot(page);
    expect(before.launchGift).toEqual({ available: false, claimed: false });
    await expect(gift(page)).toHaveCount(0);
    expect((await page.request.post(`${LAUNCH_ORIGIN}/api/events/launch-gift`, { data: {}, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(409);
    if (motion === 'reduce') await navigate(page, '/attendance');
    const claimResponse = page.waitForResponse(response => response.url().endsWith('/api/me/attendance') && response.request().method() === 'POST');
    const started = await page.evaluate(() => performance.now());
    if (motion === 'reduce') await page.getByRole('button', { name: `받기 +${before.attendance.reward}G`, exact: true }).click();
    else await page.locator('.attendance-card').getByRole('button', { name: '받기', exact: true }).click();
    await claimResponse;
    if (motion === 'no-preference') {
      await expect(page.locator('.attendance-card')).toHaveAttribute('aria-busy', 'true');
      await expect(gift(page)).toHaveCount(0);
    }
    await expect(gift(page)).toBeVisible({ timeout: 10000 });
    if (motion === 'no-preference') expect(await page.evaluate(() => performance.now()) - started).toBeGreaterThanOrEqual(700);
    if (motion === 'no-preference') await expect(page.locator('.attendance-card')).toHaveAttribute('aria-busy', 'false');
    expect(await page.evaluate(() => [...document.querySelectorAll('.home, .attendance, .fx-layer')]
      .flatMap(element => element.getAnimations({ subtree: true }))
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity && animation.playState === 'running').length)).toBe(0);
    await expect(gift(page)).toContainText('데일리 로또 이용권');
    await expect(gift(page)).toContainText('스피또 이용권');
    await expect(gift(page).locator('.launch-gift-tickets strong')).toHaveText(['5장', '5장']);
    await screenshot(page, 'authenticated', 'gift-before', width, info);
    await gift(page).getByRole('button', { name: '닫기', exact: true }).click();
    await expect(gift(page)).toHaveCount(0);
    await page.getByRole('button', { name: '선물 받기', exact: true }).click();
    await expect(gift(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(gift(page)).toHaveCount(0);
    await navigate(page, '/games');
    await expect(page.getByRole('heading', { name: '게임', exact: true })).toBeVisible();
    await navigate(page, '/');
    await expect(gift(page)).toBeVisible();
    await expect(page.locator('.fx-toast').filter({ hasText: 'G 받았어요' })).toHaveCount(0);
    const receiptPromise = page.waitForResponse(response => response.url().endsWith('/api/events/launch-gift') && response.request().method() === 'POST');
    await gift(page).getByRole('button', { name: '수령하기', exact: true }).click();
    const receipt: LaunchGiftResponse = await (await receiptPromise).json();
    expect(receipt.awarded).toBe(true);
    expect(receipt.inventory).toEqual({ lottoTickets: before.inventory.lottoTickets + 5, speettoTickets: before.inventory.speettoTickets + 5 });
    await expect(gift(page).getByRole('status')).toHaveText('선물을 받았어요');
    await screenshot(page, 'authenticated', 'gift-after', width, info);
    await gift(page).getByRole('button', { name: '확인', exact: true }).click();
    await page.reload();
    await expect(page.locator('.room-name').filter({ hasText: `${username}님` })).toBeVisible();
    await expect(gift(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '선물 받기', exact: true })).toHaveCount(0);
    const after = await snapshot(page);
    expect(after.launchGift).toEqual({ available: false, claimed: true });
    expect(after.inventory).toEqual(receipt.inventory);
    const duplicate = await page.request.post(`${LAUNCH_ORIGIN}/api/events/launch-gift`, { data: {}, headers: { Origin: new URL(page.url()).origin } });
    expect(duplicate.status()).toBe(200);
    expect(await duplicate.json()).toMatchObject({ awarded: false, inventory: receipt.inventory });
    await navigate(page, '/shop');
    await expect(page.locator('.inventory-card p').filter({ hasText: '데일리 로또 이용권' }).locator('strong')).toHaveText(`${receipt.inventory.lottoTickets}장`);
    await expect(page.locator('.inventory-card p').filter({ hasText: '스피또 이용권' }).locator('strong')).toHaveText(`${receipt.inventory.speettoTickets}장`);
    await navigate(page, '/');
    await expect(gift(page)).toHaveCount(0);
  });
}

test('preview launch gifts stay local and the new tickets can be spent at both widths', async ({ browser }, info) => {
  test.setTimeout(60000);
  for (const width of [390, 560]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(LAUNCH_NOW));
      const requests: string[] = [];
      await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
      await page.goto(`${LAUNCH_ORIGIN}/#/preview`);
      await expect(gift(page)).toHaveCount(0);
      await page.locator('.attendance-card').getByRole('button', { name: '받기', exact: true }).click();
      await expect(gift(page)).toBeVisible();
      await screenshot(page, 'preview', 'gift-before', width, info);
      await expect(page.locator('.fx-toast').filter({ hasText: 'G 받았어요' })).toHaveCount(0);
      await gift(page).getByRole('button', { name: '수령하기', exact: true }).click();
      await expect(gift(page).getByRole('status')).toHaveText('선물을 받았어요');
      await screenshot(page, 'preview', 'gift-after', width, info);
      await gift(page).getByRole('button', { name: '확인', exact: true }).click();
      await navigate(page, '/preview/shop');
      await expect(page.locator('.inventory-card p').filter({ hasText: '데일리 로또 이용권' }).locator('strong')).toHaveText('7장');
      await expect(page.locator('.inventory-card p').filter({ hasText: '스피또 이용권' }).locator('strong')).toHaveText('7장');
      await navigate(page, '/preview/shop/lotto');
      for (const number of [1, 2, 3, 4, 5]) await page.getByRole('button', { name: `번호 ${number}`, exact: true }).click();
      await page.getByRole('button', { name: /^이용권으로 사기 · 1장/ }).click();
      await expect(page.locator('.inventory-card p').filter({ hasText: '데일리 로또 이용권' }).locator('strong')).toHaveText('6장');
      await navigate(page, '/preview');
      await expect(gift(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: '선물 받기', exact: true })).toHaveCount(0);
      expect(requests).toEqual([]);
    } finally { await context.close(); }
  }
});

test('launch gifts stay unavailable outside the event date and for administrators', async ({ page, baseURL }) => {
  test.setTimeout(45000);
  await page.clock.setFixedTime(new Date('2026-10-30T00:00:00Z'));
  await login(page, 'min', baseURL);
  expect((await snapshot(page)).launchGift).toEqual({ available: false, claimed: false });
  expect((await page.request.post(`${baseURL}/api/events/launch-gift`, { data: {}, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(409);
  await expect(gift(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '선물 받기', exact: true })).toHaveCount(0);
  await page.clock.setFixedTime(new Date(LAUNCH_NOW));
  await login(page, 'admin');
  expect((await snapshot(page)).launchGift).toEqual({ available: false, claimed: false });
  expect((await page.request.post(`${LAUNCH_ORIGIN}/api/events/launch-gift`, { data: {}, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(403);
  await expect(gift(page)).toHaveCount(0);
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => localStorage.setItem('yegoom3:attendance:preview', '2026-11-02,2026-11-03'));
  await page.goto(`${LAUNCH_ORIGIN}/#/preview`);
  // The hash-only transition keeps the current document; load the seeded
  // preview attendance in a fresh document before exercising midnight.
  await page.reload();
  await expect(gift(page)).toBeVisible();
  await page.clock.setFixedTime(new Date('2026-11-03T00:00:00Z'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(gift(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.attendance-summary')).toContainText('오늘 출석 완료');
  await expect(gift(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '선물 받기', exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});
