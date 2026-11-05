import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const MORNING = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.31' });
});
async function login(page: Page, username: string) {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.31' },
    data: { username, password: 'e2e-only-password-2026' },
  });
  expect(response.status(), 'isolated fixture login').toBe(200);
}
async function capture(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const path = `docs/screenshots/notifications-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
}

test('the preview home bell carries the badge and opens the centre without APIs', async ({ page }, info) => {
  const apiCalls: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()); });
  await page.goto('/#/preview');
  // The hero shows the nickname only; the bell owns the top right corner.
  await expect(page.locator('.room-identity .gold')).toHaveCount(0);
  const bell = page.locator('.room-bell');
  await expect(bell).toHaveAttribute('aria-label', /안 읽음/);
  await expect(page.locator('.room-bell-badge')).toHaveText('3');
  await bell.click();
  await expect(page).toHaveURL(/#\/preview\/notifications$/);
  await expect(page.locator('h1').first()).toHaveText('알림');
  const rows = page.locator('.notification-row');
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toContainText('도전과제 달성! 예굼방 아케이드에 어서오세요');
  await expect(rows.nth(1)).toContainText('이번 주 토요일은 쉬어요');
  await expect(page.locator('.notification-row.unread')).toHaveCount(3);
  // Every kind words itself from its payload, including the player's name.
  await expect(rows.nth(2)).toContainText('주간 랭킹 2위 보상이 들어왔어요');
  await expect(rows.nth(3)).toContainText('siwon님이 데일리 로또 3등에 당첨됐어요');
  await expect(rows.nth(4)).toContainText('기상시간 맞히기 정답이 공개됐어요');
  await expect(rows.nth(5)).toContainText('익명의 큰손이 YK하이커스를 움직였어요');
  await capture(page, 'preview-centre', info);
  await page.setViewportSize({ width: 390, height: 900 });
  // A notice with a link opens the screen it is about.
  await rows.nth(2).click();
  await expect(page).toHaveURL(/#\/preview\/ranking$/);
  expect(apiCalls).toEqual([]);
});

test('an administrator notice reaches a player and opening the centre clears the badge', async ({ page, browser }) => {
  await login(page, 'admin');
  const sent = await page.request.post('/api/admin/notifications', {
    headers: { Origin: ORIGIN }, data: { title: '토요일은 쉬어요', body: '일요일에 다시 열려요.' },
  });
  expect(sent.status()).toBe(200);

  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  try {
    const viewer = await context.newPage();
    await viewer.clock.setFixedTime(new Date(MORNING));
    await login(viewer, 'min');
    await viewer.goto('/');
    const badge = viewer.locator('.room-bell-badge');
    await expect(badge).toHaveText(/\d+/);
    const before = Number(await badge.textContent());
    expect(before).toBeGreaterThan(0);
    await viewer.locator('.room-bell').click();
    await expect(viewer.locator('h1').first()).toHaveText('알림');
    await expect(viewer.locator('.notification-row').filter({ hasText: '토요일은 쉬어요' })).toContainText('일요일에 다시 열려요.');
    // The visit is the read mark: the badge is gone after going back home.
    await viewer.goto('/');
    await expect(viewer.locator('.room-bell-badge')).toHaveCount(0);
  } finally { await context.close(); }
});
