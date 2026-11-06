import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

/** Shop purchases ask "정말 살까요?" first (2026-11-07 update); answer yes. */
async function confirmPurchase(page: Page) {
  const dialog = page.getByRole('dialog', { name: '구매 확인', exact: true });
  await dialog.getByRole('button', { name: /^(구매하기|뽑기)$/ }).click();
  await expect(dialog).toHaveCount(0);
}

const MORNING = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.29' });
});

async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}
async function login(page: Page, username: string) {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.29' },
    data: { username, password: 'e2e-only-password-2026' },
  });
  expect(response.status(), 'isolated fixture login').toBe(200);
}
async function capture(page: Page, name: string, info: TestInfo, fullPage = true) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const path = `docs/screenshots/update-pr9-${name}-${width}.png`;
    await page.screenshot({ path, fullPage, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
}

test('preview draws a tag, wears it and shows it before the nickname without APIs', async ({ page }, info) => {
  const apiCalls: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()); });
  await page.goto('/#/preview/shop');
  const tile = page.locator('.shop-tile').filter({ hasText: '별명 태그 뽑기' });
  await expect(tile).toContainText('1회 300G');
  await expect(tile).toContainText('나를 가장 잘 나타내는 그 한 단어');
  // Every player was granted five draw tickets; the preview starts with them too.
  await expect(tile).toContainText('뽑기권 5장');
  await tile.click();
  await expect(page.locator('h1').first()).toHaveText('별명 태그 뽑기');
  await expect(page.locator('.tag-shop-odds')).toContainText('S등급');
  await capture(page, 'preview-shop', info);
  await page.setViewportSize({ width: 390, height: 900 });
  // Today's three free draws come first (2026-11-07 update), before any ticket.
  await page.getByRole('button', { name: '무료로 뽑기 · 오늘 3/3회' }).click();
  await confirmPurchase(page);
  const sheet = page.locator('dialog.tag-draw-dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.tag-draw-meta')).toContainText('오늘의 무료 뽑기');
  await expect(sheet.locator('.nick-tag')).toHaveCount(1);
  await expect(sheet.locator('small')).toHaveText(/^[SABC]등급 · (홀로그램|금빛|은빛|테두리)$/);
  const text = (await sheet.locator('.nick-tag').textContent())!;
  await capture(page, 'preview-draw', info, false);
  await page.setViewportSize({ width: 390, height: 900 });
  await sheet.getByRole('button', { name: '지금 달기' }).click();
  await expect(sheet).toContainText('지금 달고 있어요.');
  await sheet.getByRole('button', { name: '닫기' }).click();
  await expect(page.locator('.subtle-note').filter({ hasText: '오늘 1/5회' })).toContainText('뽑기권 5장');

  await navigate(page, '/preview');
  await expect(page.locator('.room-name .nick-tag')).toHaveText(text);
  await expect(page.locator('.room-name .tagged-name__text')).toHaveText('yeseo님');
  await expect(page.locator('.ranking-preview-row').filter({ hasText: 'yeseo' }).locator('.nick-tag')).toHaveText(text);
  await capture(page, 'preview-home', info);
  await navigate(page, '/preview/profile');
  const collection = page.locator('section[aria-label="내 별명 태그"]');
  await expect(collection.locator('button[aria-pressed="true"] .nick-tag')).toHaveText(text);
  await collection.scrollIntoViewIfNeeded();
  await capture(page, 'preview-profile', info);
  await page.setViewportSize({ width: 390, height: 900 });
  await collection.getByRole('button', { name: '별명 떼기' }).click();
  await expect(collection.locator('button[aria-pressed="true"]')).toHaveCount(0);
  await navigate(page, '/preview');
  await expect(page.locator('.room-name .nick-tag')).toHaveCount(0);
  expect(apiCalls).toEqual([]);
});

test('free draws come first, then a draw ticket pays before gold, and the shop counts what is left', async ({ page }) => {
  await login(page, 'min');
  const before = await (await page.request.get('/api/bootstrap')).json() as { user: { gold: number }; inventory: { tagTickets: number } };
  expect(before.inventory.tagTickets).toBe(2);
  await page.goto('/#/shop/tag');
  await expect(page.locator('.subtle-note').filter({ hasText: '오늘' })).toContainText('뽑기권 2장');
  const sheet = page.locator('dialog.tag-draw-dialog');
  for (const left of [3, 2, 1]) {
    await page.getByRole('button', { name: `무료로 뽑기 · 오늘 ${left}/3회` }).click();
    await confirmPurchase(page);
    await expect(sheet.locator('.tag-draw-meta')).toContainText('오늘의 무료 뽑기');
    await sheet.getByRole('button', { name: '보관하기' }).click();
    await expect(sheet).toHaveCount(0);
  }
  await page.getByRole('button', { name: /^뽑기 · 뽑기권 1장$|^뽑기 결과 다시 확인$/ }).click();
  await confirmPurchase(page);
  await expect(sheet.locator('.tag-draw-meta')).toContainText('뽑기권 1장');
  await sheet.getByRole('button', { name: '보관하기' }).click();
  await expect(page.locator('.subtle-note').filter({ hasText: '오늘' })).toContainText('뽑기권 1장');
  const after = await (await page.request.get('/api/bootstrap')).json() as { user: { gold: number }; inventory: { tagTickets: number } };
  expect(after.inventory.tagTickets).toBe(1);
  expect(after.user.gold).toBe(before.user.gold);
});

test('a signed-in player draws and wears a tag that other players then see', async ({ page, browser }, info) => {
  await login(page, 'yeseo');
  await page.goto('/#/shop/tag');
  await page.getByRole('button', { name: /^무료로 뽑기 · 오늘 3\/3회$|^뽑기 결과 다시 확인$/ }).click();
  await confirmPurchase(page);
  const sheet = page.locator('dialog.tag-draw-dialog');
  await expect(sheet.locator('.nick-tag')).toHaveCount(1);
  const text = (await sheet.locator('.nick-tag').textContent())!;
  await sheet.getByRole('button', { name: '지금 달기' }).click();
  await expect(sheet).toContainText('지금 달고 있어요.');
  await sheet.getByRole('button', { name: '닫기' }).click();
  await navigate(page, '/');
  await expect(page.locator('.room-name .nick-tag')).toHaveText(text);
  await navigate(page, '/profile');
  await expect(page.locator('.profile-summary h1 .nick-tag')).toHaveText(text);

  const other = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  try {
    const viewer = await other.newPage();
    await viewer.clock.setFixedTime(new Date(MORNING));
    await login(viewer, 'siwon');
    await viewer.goto('/');
    await expect(viewer.locator('.ranking-preview-row').filter({ hasText: text }).locator('.nick-tag')).toHaveText(text);
    await navigate(viewer, '/ranking');
    await expect(viewer.locator('.ranking-table .nick-tag').filter({ hasText: text })).toHaveCount(1);
    // The podium shows the tag too, above the nickname and below the photo.
    const place = viewer.locator('.podium-place').filter({ hasText: 'yeseo' });
    await expect(place.locator('.podium-name .nick-tag')).toHaveText(text);
    await expect(place.locator('.podium-name')).toContainText('yeseo');
    await capture(viewer, 'authenticated-ranking', info);
  } finally { await other.close(); }

  // Take it off again so later suites see the untagged fixture names.
  const off = await page.request.put('/api/me/nickname-tag', { headers: { Origin: ORIGIN }, data: { tagId: null } });
  expect(off.status()).toBe(200);
});
