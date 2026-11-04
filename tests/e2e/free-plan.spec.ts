import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const NOW = '2026-10-30T00:00:00Z';
// Inspect route-level module loading without the offline service worker's precache.
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.24' });
});

async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}
async function visibility(page: Page, value: 'visible' | 'hidden') {
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}
async function authenticatedClock(page: Page) {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: 'http://localhost:8788' },
    data: { username: 'siwon', password: 'e2e-only-password-2026' },
  });
  expect(login.ok()).toBe(true);
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.pauseAt(new Date(NOW));
  let reads = 0, finished = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/bootstrap') reads++; });
  page.on('requestfinished', request => { if (new URL(request.url()).pathname === '/api/bootstrap') finished++; });
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
  return Object.assign(() => reads, { finished: () => finished });
}
async function capture(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator('img').evaluateAll(images => images
      .filter(image => image.getBoundingClientRect().height > 0)
      .every(image => (image as HTMLImageElement).complete))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const path = `docs/screenshots/update-pr2-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
}

test('bootstrap polls home and ranking every 30 seconds, other screens every 60, and never the claw machine', async ({ page }) => {
  const reads = await authenticatedClock(page);
  let baseline = reads();
  await page.clock.fastForward(29999);
  expect(reads()).toBe(baseline);
  await page.clock.fastForward(1);
  await expect.poll(reads).toBe(baseline + 1);
  await expect.poll(reads.finished).toBe(baseline + 1);
  await expect(page.locator('.home')).toBeVisible();

  await navigate(page, '/ranking');
  await expect(page.locator('.podium')).toBeVisible();
  baseline = reads();
  await page.clock.fastForward(29999);
  expect(reads()).toBe(baseline);
  await page.clock.fastForward(1);
  await expect.poll(reads).toBe(baseline + 1);
  await expect.poll(reads.finished).toBe(baseline + 1);

  await navigate(page, '/profile');
  await expect(page.locator('.profile-summary')).toBeVisible();
  baseline = reads();
  await page.clock.fastForward(59999);
  expect(reads()).toBe(baseline);
  await page.clock.fastForward(1);
  await expect.poll(reads).toBe(baseline + 1);
  await expect.poll(reads.finished).toBe(baseline + 1);

  await navigate(page, '/play/claw');
  await expect.poll(async () => {
    await page.clock.runFor(50);
    // Earlier browser specs may leave this account cooling down. Polling does
    // not depend on being allowed to start another play, only on loaded state.
    const wallet = page.locator('.claw-wallet-detail');
    return await wallet.count() > 0 && /무료 \d+개 · 구매 \d+개/.test(await wallet.innerText());
  }, { intervals: [50] }).toBe(true);
  baseline = reads();
  await page.clock.fastForward(120000);
  expect(reads()).toBe(baseline);
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  expect(reads()).toBe(baseline);
});

test('hidden tabs stop polling, quick returns reuse the last read, and slow requests do not overlap', async ({ page }) => {
  const reads = await authenticatedClock(page);
  const initial = reads();
  await visibility(page, 'hidden');
  await page.clock.fastForward(9999);
  await visibility(page, 'visible');
  expect(reads()).toBe(initial);
  await visibility(page, 'hidden');
  await page.clock.fastForward(60001);
  expect(reads()).toBe(initial);
  await visibility(page, 'visible');
  await expect.poll(reads).toBe(initial + 1);
  await expect(page.locator('.home')).toBeVisible();
  // Do not advance the timer past an HTTP request that is still in flight.
  await expect.poll(reads.finished).toBe(initial + 1);
  await page.clock.fastForward(10000);

  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    // A changed label proves React has applied this slow response before the
    // immediate visibility return, rather than merely finishing the network.
    payload.user.displayName = '느린조회';
    held = true;
    await gate;
    await route.fulfill({ response, json: payload });
  });
  try {
    await visibility(page, 'visible');
    await expect.poll(() => held).toBe(true);
    const pending = reads();
    await page.clock.fastForward(60000);
    await visibility(page, 'hidden');
    await visibility(page, 'visible');
    expect(reads()).toBe(pending);
    const completed = page.waitForResponse('**/api/bootstrap');
    release();
    await completed;
    await expect(page.getByRole('heading', { name: '느린조회님', exact: true })).toBeVisible();
    await visibility(page, 'hidden');
    await visibility(page, 'visible');
    expect(reads()).toBe(pending);
  } finally { release(); }
});

test('a held previous-account read cannot block polling after logout and login', async ({ page }) => {
  const reads = await authenticatedClock(page);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let holdNext = true, held = false;
  await page.route('**/api/bootstrap', async route => {
    const hold = holdNext;
    holdNext = false;
    const response = await route.fetch();
    if (hold) { held = true; await gate; }
    await route.fulfill({ response });
  });
  try {
    await page.clock.fastForward(10000);
    await visibility(page, 'visible');
    await expect.poll(() => held).toBe(true);
    await navigate(page, '/profile');
    await page.getByRole('button', { name: '로그아웃', exact: true }).click({ force: true });
    await page.getByLabel('아이디', { exact: true }).fill('min');
    await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
    const loginResponse = page.waitForResponse('**/api/auth/login');
    await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click({ force: true });
    const { user } = await (await loginResponse).json();
    await expect(page.locator('.home')).toBeVisible();
    const baseline = reads();

    // The old response is still held while the newly signed-in account polls.
    const polled = page.waitForResponse('**/api/bootstrap', { timeout: 5000 });
    await page.clock.fastForward(30000);
    expect((await (await polled).json()).user.id).toBe(user.id);
    expect(reads()).toBe(baseline + 1);

    const stale = page.waitForResponse('**/api/bootstrap');
    release();
    await (await stale).finished();
    await navigate(page, '/profile');
    await expect(page.locator('.profile-summary h1')).toHaveText(`${user.displayName}님`);
  } finally { release(); }
});

test('preview loads admin and machine modules on entry, keeps its wallet, and makes no API calls', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(NOW));
  const apiRequests: string[] = [];
  const modules: string[] = [];
  await page.route('**/api/**', route => { apiRequests.push(route.request().url()); return route.abort(); });
  page.on('request', request => {
    if (request.resourceType() === 'script') modules.push(new URL(request.url()).pathname);
  });
  await page.goto('/#/preview');
  await expect(page.locator('.home')).toBeVisible();
  expect(modules.some(path => /\/(Admin|Stock|Claw|claw-physics|claw-preview)-/.test(path))).toBe(false);

  await navigate(page, '/preview/play/claw');
  await expect(page.getByRole('button', { name: '코인 넣기', exact: true })).toBeEnabled();
  expect(modules.some(path => /\/Claw-/.test(path))).toBe(true);
  expect(modules.some(path => /\/claw-physics-/.test(path))).toBe(true);
  await page.getByRole('button', { name: '코인 1개 사기 · 100G', exact: true }).click();
  await expect(page.locator('.claw-wallet-detail')).toContainText('무료 5개 · 구매 1개');
  await navigate(page, '/preview');
  await expect(page.locator('.home')).toBeVisible();
  await navigate(page, '/preview/play/claw');
  await expect(page.locator('.claw-wallet-detail')).toContainText('무료 5개 · 구매 1개');
  await expect(page.locator('.fx-toast')).toHaveCount(0);
  await capture(page, 'preview-claw', info);

  await navigate(page, '/preview/admin');
  await expect(page.getByRole('heading', { name: '운영', exact: true })).toBeVisible();
  expect(modules.some(path => /\/Admin-/.test(path))).toBe(true);
  expect(modules.some(path => /\/Stock-/.test(path))).toBe(false);
  await capture(page, 'preview-admin', info);
  expect(apiRequests).toEqual([]);
});
