import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const court = (page: Page) => page.locator('.freethrow-court');
const canvas = (page: Page) => page.locator('.freethrow-court canvas');
test.use({ serviceWorkers: 'block' });

/** Dispatches a pull-down then an upward flick with real event timing, the way
 * a finger (or a mouse) would, at `speed` stage heights per second. */
async function flick(page: Page, speed: number, slope = 0, { rise = 10 } = {}) {
  const box = (await canvas(page).boundingBox())!;
  await page.evaluate(({ x, y, height, speed, slope, rise }) => new Promise<void>(resolve => {
    const target = document.querySelector('.freethrow-court canvas')!;
    const fire = (type: string, px: number, py: number) => target.dispatchEvent(new PointerEvent(type, { clientX: px, clientY: py, pointerId: 7, isPrimary: true, bubbles: true, button: 0 }));
    fire('pointerdown', x, y);
    const step = 16, pull = 6, perStep = speed * height * step / 1000;
    let i = 0;
    const tick = () => {
      i++;
      if (i <= pull) fire('pointermove', x, y + i * 9);
      else {
        const k = i - pull, px = x + slope * perStep * k, py = y + pull * 9 - perStep * k;
        if (k < rise) fire('pointermove', px, py); else { fire('pointerup', px, py); resolve(); return; }
      }
      setTimeout(tick, step);
    };
    setTimeout(tick, step);
  }), { x: box.x + box.width / 2, y: box.y + box.height * (423 / 560), height: box.height, speed, slope, rise });
}
const idle = (page: Page) => expect(court(page)).toHaveAttribute('data-mode', 'idle', { timeout: 6000 });

test('free-throw practice runs in preview without the server and explains every shot', async ({ page }) => {
  const api: string[] = [];
  await page.route('**/api/**', route => { api.push(route.request().url()); return route.abort(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview');
  const tile = page.getByRole('button', { name: /자유투 대결/ });
  await expect(tile).toContainText('연습 모드');
  await tile.click();
  await expect(page).toHaveURL(/#\/preview\/play\/freethrow$/);
  await expect(page.getByRole('heading', { name: '자유투 대결' })).toBeVisible();
  await expect(court(page)).toHaveAttribute('data-mode', 'idle');
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/freethrow-step1-idle-390.png', fullPage: true });

  // A tap is not a throw: the ball goes back and the hint explains the motion.
  await flick(page, 2.4, 0, { rise: 1 });
  await expect(page.locator('.freethrow-status')).toContainText('위로 빠르게 쓸어 올리며');
  await expect(page.locator('.freethrow-board')).toContainText('0/0');

  // A straight flick at a comfortable speed lands in the scoring band.
  await flick(page, 2.45);
  await expect(page.locator('.freethrow-callout')).toHaveClass(/is-made/, { timeout: 4000 });
  await expect(page.locator('.freethrow-board')).toContainText('1/1');
  const power = Number(await page.locator('.freethrow-meter b').innerText());
  expect(power).toBeGreaterThanOrEqual(51);
  expect(power).toBeLessThanOrEqual(59);
  await expect(page.locator('.freethrow-aim b')).toHaveText('가운데');
  await page.screenshot({ path: 'docs/screenshots/freethrow-step1-made-390.png', fullPage: true });
  await idle(page);

  // Leaning hard to the left misses left, and the copy says so.
  await flick(page, 2.45, -0.6);
  await expect(page.locator('.freethrow-callout')).toHaveClass(/is-miss/, { timeout: 4000 });
  await expect(page.locator('.freethrow-callout strong')).toContainText('왼쪽');
  await expect(page.locator('.freethrow-aim b')).toContainText('왼쪽');
  await expect(page.locator('.freethrow-board')).toContainText('1/2');
  await expect(page.locator('.freethrow-recent i.is-made')).toHaveCount(1);
  await expect(page.locator('.freethrow-recent i.is-miss')).toHaveCount(1);
  await idle(page);

  // Too gentle falls short.
  await flick(page, 1.0);
  await expect(page.locator('.freethrow-callout strong')).toHaveText('짧았어요', { timeout: 4000 });
  await idle(page);
  await page.getByRole('button', { name: '기록 지우기' }).click();
  await expect(page.locator('.freethrow-board')).toContainText('0/0');
  expect(api).toEqual([]);
});

test('free-throw sound preference survives a reload and the court fits a wide screen', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 560, height: 980 });
  await page.goto('/#/preview/play/freethrow');
  await expect(page.getByRole('button', { name: '소리 켜짐' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '소리 켜짐' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '소리 꺼짐' })).toHaveAttribute('aria-pressed', 'false');
  const box = (await canvas(page).boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(360 / 560, 2);
  const size = await canvas(page).evaluate((element: HTMLCanvasElement) => ({ width: element.width, css: element.getBoundingClientRect().width }));
  expect(size.width).toBeGreaterThanOrEqual(Math.round(size.css));
  await flick(page, 2.45);
  await expect(page.locator('.freethrow-callout')).toHaveClass(/is-made/, { timeout: 4000 });
  await page.screenshot({ path: 'docs/screenshots/freethrow-step1-made-560.png', fullPage: true });
});
