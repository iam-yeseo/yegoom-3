import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse } from '../../shared/types';

const NOW = '2026-10-30T00:00:00Z';
// UTC is still October 29 here; displayed dates and clocks must remain KST.
test.use({ timezoneId: 'America/Los_Angeles' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.22' });
});

async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}

async function captureWidths(page: Page, name: string, info: TestInfo, modal = false) {
  await mkdir('docs/screenshots', { recursive: true });
  for (let i = 0; i < 5 && await page.locator('.announcement-banner').count(); i++) {
    await page.locator('.announcement-banner').click();
  }
  await expect(page.locator('.announcement-banner')).toHaveCount(0);
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator('img').evaluateAll(images => images
      .filter(image => image.getBoundingClientRect().height > 0)
      .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {}))));
    await expect(page.locator('.fx-toast')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${name} at ${width}px`).toBe(false);
    if (!modal) await page.evaluate(() => scrollTo(0, 0));
    const path = `docs/screenshots/update-pr1-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: !modal, animations: 'disabled' });
    await info.attach(`${name}-${width}px`, { path, contentType: 'image/png' });
  }
}

test('preview names, dates and second-precision results share the display rules without an API', async ({ page }, info) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto('/#/preview');
  await expect(page.getByRole('heading', { name: 'yeseo님', exact: true })).toBeVisible();
  await expect(page.locator('.game-row').filter({ hasText: '기상시간' })).toContainText('10시 30분');
  await captureWidths(page, 'preview-home', info);

  await navigate(page, '/preview/game/offwork');
  await expect(page.locator('.answer-number')).toHaveText('18시 12분 30초');
  await expect(page.locator('.result-list .result-name strong')).toHaveText(['yeseo님 (나)', 'min님']);
  await expect(page.locator('.result-list .result-guess')).toHaveText(['18시 12분 45초', '18시 13분 31초']);
  await expect(page.locator('.history-heading h3').first()).toHaveText('2026년 10월 29일');
  await expect(page.locator('.history-heading strong').first()).toHaveText('18시 02분 30초');
  await captureWidths(page, 'preview-prediction-result', info);

  await navigate(page, '/preview/play/kuji');
  await page.getByRole('button', { name: 'A상 보상 보기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'A상 보상', exact: true });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await captureWidths(page, 'preview-kuji-modal', info, true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  expect(requests).toEqual([]);
});

test('nickname values remain raw while every displayed name adds the honorific', async ({ page }) => {
  await page.goto('/#/preview/profile');
  const nickname = page.getByLabel('닉네임', { exact: true });
  await expect(nickname).toHaveValue('yeseo');
  await expect(page.locator('.profile-summary h1')).toHaveText('yeseo님');
  // A literal nickname ending in 님 is still a raw name, not preformatted text.
  await nickname.fill('별님');
  await page.getByRole('button', { name: '닉네임 저장', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '닉네임을 저장했어요.' })).toBeVisible();
  await expect(nickname).toHaveValue('별님');
  await expect(page.locator('.profile-summary h1')).toHaveText('별님님');
  await navigate(page, '/preview');
  await expect(page.getByRole('heading', { name: '별님님', exact: true })).toBeVisible();
  await navigate(page, '/preview/game/offwork');
  await expect(page.locator('.result-list .result-name strong').first()).toHaveText('별님님 (나)');
});

test('authenticated names and ISO ledger timestamps use the same KST display rules', async ({ page }, info) => {
  await page.goto('/');
  const username = page.getByLabel('아이디', { exact: true });
  await username.fill('min');
  await expect(username).toHaveValue('min');
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await expect(page.locator('.home')).toBeVisible();
  const response = await page.request.get('/api/bootstrap');
  expect(response.ok()).toBe(true);
  const data = await response.json() as BootstrapResponse;
  await navigate(page, '/profile');
  await expect(page.locator('.profile-summary h1')).toHaveText(`${data.user.displayName}님`);
  await expect(page.getByLabel('닉네임', { exact: true })).toHaveValue(data.user.displayName);
  const gold = data.ledger.filter(entry => entry.currency === 'gold');
  expect(gold.length).toBeGreaterThan(0);
  const times = gold.map(entry => {
    const kst = new Date(Date.parse(entry.createdAt) + 9 * 60 * 60 * 1000).toISOString();
    return `${kst.slice(11, 13)}시 ${kst.slice(14, 16)}분`;
  });
  await expect(page.locator('.history-text small')).toHaveText(times);
  // The fixture has midnight-UTC activity; it must show 09시 rather than the browser's 17시.
  expect(times).toContain('09시 00분');
  await captureWidths(page, 'authenticated-profile', info);
});
