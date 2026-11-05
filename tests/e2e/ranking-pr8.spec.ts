import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const MORNING = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.28' });
});

async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}
async function login(page: Page, username: string) {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.28' },
    data: { username, password: 'e2e-only-password-2026' },
  });
  expect(response.status(), 'isolated fixture login').toBe(200);
}
async function capture(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator('img').evaluateAll(images => images
      .filter(image => image.getBoundingClientRect().height > 0)
      .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.evaluate(() => { scrollTo(0, 0); return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const path = `docs/screenshots/update-pr8-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
}

test('preview ranking toggles day, week and month, remembers the choice and pages the score log without APIs', async ({ page }, info) => {
  const apiCalls: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url()); });
  await page.goto('/#/preview/ranking');
  const tabs = page.getByRole('tablist', { name: '랭킹 기간' });
  await expect(tabs.getByRole('tab', { name: '주간' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('h1').first()).toContainText('주간 랭킹');
  // This week's preview totals equal the home preview's weekly scores.
  await expect(page.locator('.ranking-table .list-row > b')).toHaveText(['412점', '340점', '285점']);
  await expect(page.locator('.ranking-table .list-row > strong')).toHaveText(['siwon', 'yeseo', 'min']);
  await expect(page.locator('.daily-card h2')).toHaveText('요일별 점수');
  await expect(page.locator('.daily-bars > div')).toHaveCount(7);
  // The score and reward rules sit at the bottom, folded shut by default.
  const rules = page.locator('details.ranking-rules');
  await expect(rules.locator('summary')).toHaveText('점수와 보상 규칙');
  await expect(rules.locator('ul')).toBeHidden();
  await rules.locator('summary').click();
  await expect(rules.locator('ul')).toBeVisible();
  await expect(rules).toContainText('주간 보상은 그 주 점수 × 순위 배수(1위 ×5 · 2위 ×4 · 3위 ×3)');
  await expect(rules).toContainText('월간 보상은 그 달 점수 × 순위 배수(1위 ×2 · 2위 ×1.5 · 3위 ×1)');
  // The preview viewer sits second with 340 points: 340 × 4 = 1,360G.
  await expect(rules.locator('.ranking-rules-projection')).toContainText('1,360G');
  // Photos (or the chosen character) sit next to every ranking name; no "님" in rankings.
  await expect(page.locator('.podium-block > .avatar')).toHaveCount(3);
  await expect(page.locator('.ranking-table .avatar')).toHaveCount(3);
  await expect(page.locator('.ranking-table')).not.toContainText('님');
  await expect(page.locator('.podium')).not.toContainText('님');
  const log = page.locator('.ranking-history');
  await expect(log.locator('h2')).toHaveText('점수 획득 기록');
  await expect(log.locator('.history-row')).toHaveCount(20);
  await expect(log.locator('.history-row').first().locator('.avatar')).toHaveCount(1);
  await expect(log.locator('.history-row small').first()).toHaveText(/^2026년 10월 30일 \d{2}시 \d{2}분$/);
  await capture(page, 'preview-week', info);
  await page.setViewportSize({ width: 390, height: 900 });
  await log.getByRole('button', { name: '더 보기' }).click();
  await expect.poll(() => log.locator('.history-row').count()).toBeGreaterThan(20);

  await tabs.getByRole('tab', { name: '일간' }).click();
  await expect(page.locator('h1').first()).toContainText('일간 랭킹');
  await expect(page.locator('.daily-card h2')).toHaveText('게임별 점수');
  await expect(page.locator('.ranking-week')).toContainText('오늘 종료까지');
  // Daily rankings pay nothing, so the projection is not shown at all.
  await expect(page.locator('.ranking-rules-projection')).toHaveCount(0);
  await capture(page, 'preview-day', info);
  await tabs.getByRole('tab', { name: '월간' }).click();
  await expect(page.locator('h1').first()).toContainText('월간 랭킹');
  await expect(page.locator('.daily-card h2')).toHaveText('주차별 점수');
  await expect(page.locator('.daily-bars small')).toHaveText(['1주차', '2주차', '3주차', '4주차', '5주차']);
  await capture(page, 'preview-month', info);

  // The projection follows the chosen period and stays off for a single day.
  await expect(page.locator('.ranking-rules-projection')).toHaveText(/^지금 순위 그대로면 [\d,]+G를 받아요\.$/);

  await page.reload();
  await expect(page.getByRole('tablist', { name: '랭킹 기간' }).getByRole('tab', { name: '월간' })).toHaveAttribute('aria-selected', 'true');
  expect(apiCalls).toEqual([]);
});

test('signed-in ranking reads each period from the server once within thirty seconds and shows real photos', async ({ page }, info) => {
  await login(page, 'yeseo');
  const periods: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/ranking') periods.push(url.searchParams.get('period')!);
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('yegoom3:ranking-period'));
  await navigate(page, '/ranking');
  await expect(page.locator('.ranking-table .list-row')).toHaveCount(3);
  // Other suites share this database, so compare with the server's own answer.
  const week = await (await page.request.get('/api/ranking?period=week')).json() as { standings: { score: number }[] };
  await expect(page.locator('.ranking-table .list-row > b')).toHaveText(week.standings.map(row => `${row.score.toLocaleString('ko-KR')}점`));
  await expect(page.locator('.ranking-history h2')).toHaveText('점수 획득 기록');
  const tabs = page.getByRole('tablist', { name: '랭킹 기간' });
  await tabs.getByRole('tab', { name: '월간' }).click();
  await expect(page.locator('.daily-card h2')).toHaveText('주차별 점수');
  await tabs.getByRole('tab', { name: '주간' }).click();
  await expect(page.locator('.daily-card h2')).toHaveText('요일별 점수');
  await capture(page, 'authenticated-week', info);
  // Week and month were each fetched once by the screen; switching back reused the 30-second cache.
  expect(periods).toEqual(['week', 'month']);
});
