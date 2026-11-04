import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-30T00:00:00Z'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
const px = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => parseFloat(getComputedStyle(node).fontSize));
const box = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => node.getBoundingClientRect().width);

test('내 정보 글자 크기: 크게 is the original size, smaller choices shrink only text and persist per device', async ({ page }, info) => {
  await page.goto('/#/preview/profile');
  const control = page.getByRole('tablist', { name: '글자 크기' });
  await expect(control.getByRole('tab', { name: '크게' })).toHaveAttribute('aria-selected', 'true');
  const titleLarge = await px(page, '.font-size-setting h2');
  expect(titleLarge).toBe(17); // the original design value
  const cardWidth = await box(page, '.font-size-setting');

  await control.getByRole('tab', { name: '보통' }).click();
  expect(await px(page, '.font-size-setting h2')).toBeCloseTo(17 * 0.93, 1);
  await control.getByRole('tab', { name: '작게' }).click();
  expect(await px(page, '.font-size-setting h2')).toBeCloseTo(17 * 0.86, 1);
  // Layout width is unchanged; only text scales.
  expect(await box(page, '.font-size-setting')).toBe(cardWidth);

  await page.reload();
  await expect(page.getByRole('tablist', { name: '글자 크기' }).getByRole('tab', { name: '작게' })).toHaveAttribute('aria-selected', 'true');
  expect(await px(page, '.font-size-setting h2')).toBeCloseTo(17 * 0.86, 1);
  await page.goto('/#/preview');
  expect(await page.evaluate(() => document.documentElement.dataset.fontSize)).toBe('small');
  expect(await px(page, '.home h1')).toBeLessThan(18);
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const path = `docs/screenshots/update-font-size-small-home-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`small-home-${width}`, { path, contentType: 'image/png' });
  }
});
