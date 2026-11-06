import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function shot(page: Page, name: string, info: TestInfo, fullPage = true) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const path = `docs/screenshots/stock-pr10-${name}-${width}.png`;
    await page.screenshot({ path, fullPage, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
  await page.setViewportSize({ width: 390, height: 900 });
}

test('preview market lists fifteen stocks, trades with fees and shows dated news without any API call', async ({ page }, info) => {
  test.setTimeout(90_000);
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.clock.setFixedTime(new Date('2026-11-05T02:03:00Z')); // Thursday 11:03 KST
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 900 });

  await page.goto('/#/preview/games');
  const tile = page.getByRole('button').filter({ hasText: '주식 시장' });
  await expect(tile).toContainText('장 열림');
  await expect(tile).toContainText('내 손익');
  await tile.click();
  await expect(page).toHaveURL(/#\/preview\/stock$/);
  const rows = page.getByRole('region', { name: '종목' }).getByRole('button');
  await expect(rows).toHaveCount(15);
  await expect(page.locator('.market-pill')).toContainText('장 열림 · 18시 00분 마감');
  for (const name of ['YK하이커스', 'SW전자', 'MJ일렉트로닉스', '예도어', '더워스쿨', '민두래곤', '소니항공', '에바참치', '리안뷰티', '예굼', 'GU', '피자대학', '구로미해적단', '고글', '야마존']) {
    await expect(rows.filter({ hasText: name })).toHaveCount(1);
  }
  await expect(rows.filter({ hasText: '예굼' })).toContainText('20주 보유');
  await expect(page.locator('main')).not.toContainText('NaN');
  await shot(page, 'list', info);

  await rows.filter({ hasText: '예굼' }).click();
  await expect(page).toHaveURL(/#\/preview\/stock\/YEGM$/);
  await expect(page.getByText('세계 최초, 모기 사냥에 성공하면')).toBeVisible();
  const priceText = await page.locator('.detail-head p strong').innerText();
  const price = Number(priceText.replace(/,/g, ''));
  const goldBefore = Number((await page.locator('.game-toolbar .gold').innerText()).replace(/[^\d]/g, ''));
  await page.getByRole('button', { name: '수량 늘리기' }).click();
  const fee = Math.max(1, Math.ceil(price * 2 / 100));
  await expect(page.locator('.trade-total')).toContainText(`${(price * 2 + fee).toLocaleString('ko-KR')}G`);
  await page.getByRole('button', { name: '2주 사기' }).click();
  const sheet = page.getByRole('dialog', { name: '거래 확인' });
  await expect(sheet).toContainText('수수료 1%');
  await shot(page, 'confirm', info, false);
  await sheet.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.holding')).toContainText('22주');
  await expect.poll(async () => Number((await page.locator('.game-toolbar .gold').innerText()).replace(/[^\d]/g, ''))).toBe(goldBefore - price * 2 - fee);
  await shot(page, 'detail', info);

  await page.getByRole('tab', { name: '팔기' }).click();
  await page.getByRole('button', { name: '1주 팔기' }).click();
  await page.getByRole('dialog', { name: '거래 확인' }).getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.holding')).toContainText('21주');
  for (const range of ['1주', '1개월']) {
    await page.getByRole('tab', { name: range }).click();
    await expect(page.locator('.chart-card svg')).toHaveAttribute('aria-label', new RegExp(`최근 ${range} 예굼`));
  }

  await page.goto('/#/preview/stock/news');
  await expect(page.locator('.stock-news-item').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /2026년 11월/ }).first()).toBeVisible();
  await shot(page, 'news', info);

  await page.goto('/#/preview/profile');
  await expect(page.getByText('주식 매수 · 예굼 2주')).toBeVisible();
  expect(requests).toEqual([]);
});

test('preview market closes on weekends and stays readable', async ({ page }, info) => {
  await page.route('**/api/**', route => route.abort());
  await page.clock.setFixedTime(new Date('2026-11-07T03:00:00Z')); // Saturday
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/preview/stock');
  await expect(page.getByRole('heading', { name: '주말 휴장' })).toBeVisible();
  await expect(page.getByText('2026년 11월 09일 09시 00분 개장')).toBeVisible();
  await shot(page, 'weekend', info);
  await page.getByRole('region', { name: '종목' }).getByRole('button').filter({ hasText: 'YK하이커스' }).click();
  await expect(page.getByRole('button', { name: '주말 휴장' })).toBeDisabled();
});
