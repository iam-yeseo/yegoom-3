import { expect, type Page } from '@playwright/test';

/** No overlay left the page frozen: its styles are back and a scroll moves it. */
export async function expectPageScrolls(page: Page) {
  expect(await page.evaluate(() => [document.body.style.overflow, document.body.style.position, document.documentElement.style.overflowY]))
    .toEqual(['', '', '']);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
}
