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
  // Three unread alarms and one 공지 that has not been opened yet.
  await expect(page.locator('.room-bell-badge')).toHaveText('4');
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
  // 알림 | 공지: the 공지 side lists patch notes as posts, each with its date.
  const notices = page.getByRole('tab', { name: /공지/ });
  await expect(notices.locator('.segmented-badge')).toHaveText('1');
  await notices.click();
  await expect(page).toHaveURL(/#\/preview\/notifications\/notices$/);
  const post = page.locator('.notice-post').first();
  await expect(post.locator('time')).toHaveText(/^\d{4}년 \d{1,2}월 \d{1,2}일$/);
  await expect(post.locator('.notice-new')).toBeVisible();
  await expect(post.locator('.notice-body')).toHaveCount(0);
  await capture(page, 'preview-notices', info);
  await page.setViewportSize({ width: 390, height: 900 });
  // Opening the post reads it: the toggle's count goes, and so does one from the bell.
  await post.locator('.notice-head').click();
  await expect(post.locator('.notice-body li').first()).toBeVisible();
  await expect(notices.locator('.segmented-badge')).toHaveCount(0);
  await capture(page, 'preview-notice-open', info);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('tab', { name: '알림' }).click();
  await expect(page).toHaveURL(/#\/preview\/notifications$/);
  // A notice with a link opens the screen it is about.
  await rows.nth(2).click();
  await expect(page).toHaveURL(/#\/preview\/ranking$/);
  await page.goto('/#/preview');
  await expect(page.locator('.room-bell-badge')).toHaveText('3');
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
    // The visit is the read mark for alarms. The 공지 nobody opened yet keeps the badge on.
    await viewer.goto('/');
    await expect(viewer.locator('.room-bell-badge')).toHaveText('1');
    await expect(viewer.locator('.room-bell')).toHaveAttribute('aria-label', /공지 1개 포함/);
    // With only a notice left, the bell opens on the 공지 side.
    await viewer.locator('.room-bell').click();
    await expect(viewer).toHaveURL(/#\/notifications\/notices$/);
    await expect(viewer.getByRole('tab', { name: /공지/ })).toHaveAttribute('aria-selected', 'true');
    // Looking at the list is not reading: the post has to be opened.
    await viewer.goto('/');
    await expect(viewer.locator('.room-bell-badge')).toHaveText('1');
    await viewer.goto('/#/notifications/notices');
    const post = viewer.locator('.notice-post').first();
    await expect(post.locator('.notice-new')).toBeVisible();
    const saved = viewer.waitForResponse(response => response.url().endsWith('/api/notices/read') && response.status() === 200);
    await post.locator('.notice-head').click();
    await saved;
    await expect(post.locator('.notice-body li').first()).toBeVisible();
    await viewer.goto('/');
    await expect(viewer.locator('.room-bell-badge')).toHaveCount(0);
    // It stays read after a reload (it is kept on the server).
    await viewer.reload();
    await expect(viewer.locator('.room-identity')).toBeVisible();
    await expect(viewer.locator('.room-bell-badge')).toHaveCount(0);
  } finally { await context.close(); }
});
