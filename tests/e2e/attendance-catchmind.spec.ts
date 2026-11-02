import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse } from '../../shared/types';

const NOW = '2026-11-02T15:00:00Z'; // First instant of November 3 KST.
const ORIGIN = 'http://localhost:8791';
let server: ChildProcess | undefined;
let log: WriteStream | undefined;
async function stopServer() {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const child = server;
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* Already stopped. */ }
    const force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already stopped. */ } }, 5000);
    await stopped; clearTimeout(force);
  }
  server = undefined; log?.end();
}
test.beforeAll(async ({}, info) => {
  info.setTimeout(120000);
  log = createWriteStream(`/tmp/yegoom-attendance-catchmind-worker-${process.pid}.log`);
  server = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, E2E_PORT: '8791', E2E_NOW: NOW, E2E_PROFILE: 'attendance-catchmind' },
  });
  server.stdout!.pipe(log, { end: false }); server.stderr!.pipe(log, { end: false });
  try {
    await expect.poll(async () => {
      if (server!.exitCode !== null) throw new Error(`Attendance fixture exited: ${server!.exitCode}`);
      try { return (await fetch(`${ORIGIN}/api/health`)).ok; } catch { return false; }
    }, { timeout: 90000, intervals: [200, 500] }).toBe(true);
  } catch (e) { await stopServer(); throw e; }
});
test.afterAll(stopServer);
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.14' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
async function login(page: Page, username: string) {
  await page.goto(`${ORIGIN}/`);
  await page.getByLabel('아이디', { exact: true }).fill(username);
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await expect(page.locator('.home')).toBeVisible();
}
async function navigate(page: Page, path: string) { await page.evaluate(value => { location.hash = value; }, path); }
async function capture(page: Page, mode: string, state: string, width: number, info: TestInfo) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.fx-toast')).toHaveCount(0);
  if (!await page.getByRole('dialog').count()) {
    for (let i = 0; i < 5 && await page.locator('.announcement-banner').count(); i++) await page.locator('.announcement-banner').click();
  }
  for (const img of await page.locator('.cm-gallery-tile img, .cm-previous-open img').all()) await img.scrollIntoViewIfNeeded();
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.locator('.cm-gallery-tile img, .cm-previous-open img, .cm-gallery-picture').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/admin-pr1-${mode}-${state}-${width}.png`;
  await page.screenshot({ path, fullPage: true });
  await info.attach(`${mode}-${state}-${width}`, { path, contentType: 'image/png' });
}

for (const mode of ['authenticated', 'preview'] as const) for (const width of [390, 560]) {
  test(`${mode} attendance, previous round and gallery at ${width}px`, async ({ page }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    const preview = mode === 'preview';
    const prefix = preview ? '/preview' : '';
    const apiRequests: string[] = [];
    if (preview) {
      await page.route('**/api/**', route => { apiRequests.push(route.request().url()); return route.abort(); });
      await page.goto(`${ORIGIN}/#/preview`);
    } else await login(page, width === 390 ? 'siwon' : 'yeseo');
    await expect(page.locator('.attendance-card')).toContainText('100G + 로또 1 + 스피또 1');
    await capture(page, mode, 'attendance-card', width, info);
    await navigate(page, `${prefix}/attendance`);
    await expect(page.locator('.attendance-reward')).toHaveText('오늘의 보상 · 100G + 로또 1 + 스피또 1');
    await capture(page, mode, 'attendance-screen', width, info);
    await page.getByRole('button', { name: '받기 +100G', exact: true }).click();
    await expect(page.locator('.fx-toast')).toContainText('+100G + 로또 1 + 스피또 1 받았어요');
    if (!preview) {
      const view = await (await page.request.get(`${ORIGIN}/api/bootstrap`)).json() as BootstrapResponse;
      expect(view.inventory).toEqual({ lottoTickets: 3, speettoTickets: 3 });
    }
    await navigate(page, `${prefix}/play/catchmind`);
    const previous = page.getByRole('region', { name: '지난 판', exact: true });
    await expect(previous).toContainText('제 12판');
    if (!preview) {
      await expect(previous).toContainText('그리는 민');
      await expect(previous.locator('img[src*="/api/users/e2e-min/photo"]')).toBeVisible();
      await expect(page.locator('.pg-catchmind')).not.toContainText('비공개제시어');
    }
    await capture(page, mode, 'previous-round', width, info);
    await previous.getByRole('button', { name: '지난 판 제 12판 크게 보기' }).click();
    await expect(page.getByRole('dialog', { name: '제 12판', exact: true })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 11판');
    await expect(page.getByRole('dialog')).toContainText('아무도 못 맞혔어요');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 12판');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(previous.getByRole('button', { name: '지난 판 제 12판 크게 보기' })).toBeFocused();
    await previous.getByRole('link', { name: '갤러리 보기' }).click();
    await expect(page).toHaveURL(new RegExp(`${prefix}/play/catchmind/gallery$`));
    await expect(page.locator('.cm-gallery-tile')).toHaveCount(9);
    expect(await page.locator('.cm-gallery-tile').evaluateAll(tiles => tiles.slice(0, 3).every(tile => tile.getBoundingClientRect().top === tiles[0].getBoundingClientRect().top) && tiles[3].getBoundingClientRect().top > tiles[0].getBoundingClientRect().top)).toBe(true);
    await expect(page.locator('.cm-gallery-tile').first()).toHaveAccessibleName('12판 · 맞힌 판 크게 보기');
    await expect(page.locator('.cm-gallery-tile img').first()).toHaveAttribute('loading', 'lazy');
    await capture(page, mode, 'gallery', width, info);
    await page.locator('.cm-gallery-tile').first().click();
    await capture(page, mode, 'gallery-modal', width, info);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.locator('.cm-gallery-tile').last().click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 4판');
    await page.getByRole('button', { name: '이전 판', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 3판');
    await expect(page.getByRole('button', { name: '이전 판', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 2판');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 1판');
    await expect(page.getByRole('button', { name: '이전 판', exact: true })).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('제 2판');
    await page.mouse.click(2, 2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.cm-gallery-tile')).toHaveCount(12);
    await expect(page.getByRole('button', { name: '더 보기', exact: true })).toHaveCount(0);
    if (preview) expect(apiRequests).toEqual([]);
  });
}

test('seventh-day attendance shows 500G with coupons; gallery loads more and survives an ended round', async ({ page }) => {
  await login(page, 'min');
  await expect(page.locator('.attendance-card')).toContainText('500G + 로또 1 + 스피또 1');
  await navigate(page, '/attendance');
  await expect(page.locator('.attendance-reward')).toContainText('500G + 로또 1 + 스피또 1');
  await page.getByRole('button', { name: '받기 +500G', exact: true }).click();
  await expect(page.locator('.fx-toast')).toContainText('500G + 로또 1 + 스피또 1 받았어요');
  await navigate(page, '/play/catchmind/gallery');
  await expect(page.locator('.cm-gallery-tile')).toHaveCount(9);
  await page.getByRole('button', { name: '더 보기', exact: true }).click();
  await expect(page.locator('.cm-gallery-tile')).toHaveCount(12);
  const response = await page.request.post(`${ORIGIN}/api/catchmind/end`, { headers: { Origin: ORIGIN }, data: { requestId: crypto.randomUUID(), roundId: 'fixture-gallery-13' } });
  expect(response.status()).toBe(200);
  await navigate(page, '/play/catchmind');
  await expect(page.locator('.pg-result-picture')).toContainText('비공개제시어');
  await expect(page.getByRole('region', { name: '지난 판' })).toContainText('제 12판');
  await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
  await expect(page.getByRole('region', { name: '지난 판' })).toContainText('제 13판');
});

test('gallery empty, request failure and retry states remain usable', async ({ page }) => {
  await login(page, 'admin');
  await page.route('**/api/catchmind/gallery*', route => route.fulfill({ status: 500, json: { error: { message: '갤러리 연결 실패' } } }));
  await navigate(page, '/play/catchmind/gallery');
  await expect(page.getByRole('alert')).toHaveText('갤러리 연결 실패');
  await page.route('**/api/catchmind/gallery*', route => route.fulfill({ json: { rounds: [], nextBefore: null } }));
  await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(page.locator('.cm-gallery-empty')).toHaveText('아직 완성된 그림이 없어요. 첫 그림의 주인공이 되어 보세요!');
});
