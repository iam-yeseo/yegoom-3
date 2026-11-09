import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { RankResult } from '../../shared/ranking-rewards';

const MORNING = '2026-10-30T00:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.41' });
});
async function login(page: Page, username: string) {
  const response = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.41' },
    data: { username, password: 'e2e-only-password-2026' },
  });
  expect(response.status(), 'isolated fixture login').toBe(200);
}
/** The real bootstrap, with the settled results the dialog announces. */
async function withResults(page: Page, results: RankResult[]) {
  let served = false;
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, rankResults: served ? [] : results } });
    served = true;
  });
}
const week: RankResult = { period: 'week', key: '2026-11-02', start: '2026-11-02', end: '2026-11-08', place: 1, score: 188, gold: 940, players: 3 };
const month: RankResult = { period: 'month', key: '2026-11', start: '2026-11-01', end: '2026-11-30', place: 4, score: 30, gold: 0, players: 4 };

test('the first home visit after a settlement announces the place and reward once', async ({ page }) => {
  await login(page, 'min');
  await withResults(page, [week]);
  const seen: unknown[] = [];
  await page.route('**/api/ranking/results/seen', async route => { seen.push(route.request().postDataJSON()); await route.fulfill({ json: { results: [] } }); });
  await page.goto('/');
  const dialog = page.locator('.rank-result-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('주간 랭킹 집계 완료!');
  await expect(dialog).toContainText('지난주 랭킹은 1위!');
  await expect(dialog).toContainText('3명 중 1위 · 188점');
  await expect(dialog).toContainText('보상은 940G!');
  await mkdir('docs/screenshots', { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshots/rank-result-week-390.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '확인' }).click();
  await expect(dialog).toHaveCount(0);
  expect(seen).toEqual([{ results: [{ period: 'week', key: '2026-11-02' }] }]);
});

test('a week and a month settled together share one dialog, and no podium still hears its place', async ({ page }) => {
  await login(page, 'min');
  await withResults(page, [week, month]);
  await page.route('**/api/ranking/results/seen', route => route.fulfill({ json: { results: [] } }));
  await page.goto('/');
  const dialog = page.locator('.rank-result-dialog');
  await expect(dialog.locator('h2')).toHaveText('랭킹 집계 완료!');
  await expect(dialog.locator('.rank-result-card')).toHaveCount(2);
  await expect(dialog.locator('.rank-result-card').nth(1)).toContainText('지난달 랭킹은 4위!');
  await expect(dialog.locator('.rank-result-card').nth(1)).toContainText('이번엔 보상이 없어요');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshots/rank-result-both-390.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '랭킹 보러 가기' }).click();
  await expect(page).toHaveURL(/#\/ranking$|\/ranking$/);
  await expect(dialog).toHaveCount(0);
});
