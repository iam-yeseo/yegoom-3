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
/** Balls already decided in the official progress bar. */
const decided = (page: Page) => page.locator('.play-progress-bar i.is-hit, .play-progress-bar i.is-miss');
async function throwSet(page: Page, speed: (i: number) => number) {
  let goals = 0;
  for (let i = 0; i < 10; i++) {
    await flick(page, speed(i));
    await expect(decided(page)).toHaveCount(i + 1, { timeout: 6000 });
    if (await page.locator('.freethrow-callout').evaluate(element => element.classList.contains('is-made'))) goals++;
    await idle(page);
  }
  return goals;
}

test('free-throw practice plays full screen in preview without the server and explains every shot', async ({ page }) => {
  const api: string[] = [];
  await page.route('**/api/**', route => { api.push(route.request().url()); return route.abort(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview');
  const tile = page.getByRole('button', { name: /자유투 대결/ });
  await expect(tile).toContainText('이번 세트 도전 가능');
  await tile.click();
  await expect(page).toHaveURL(/#\/preview\/play\/freethrow$/);
  await expect(page.getByRole('heading', { name: '자유투 대결' })).toBeVisible();
  await mkdir('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/freethrow-lobby-390.png', fullPage: true });
  await page.getByRole('button', { name: '연습하기' }).click();
  const shell = page.getByRole('region', { name: '자유투 연습' });
  await expect(shell).toBeVisible();
  await expect(court(page)).toHaveAttribute('data-mode', 'idle');
  await page.screenshot({ path: 'docs/screenshots/freethrow-practice-idle-390.png' });

  // A tap is not a throw: the ball goes back and the hint explains the motion.
  await flick(page, 2.4, 0, { rise: 1 });
  await expect(page.locator('.freethrow-status')).toContainText('위로 빠르게 쓸어 올리며');
  await expect(page.locator('.freethrow-practice-stats')).toContainText('0/0');

  // A straight flick at a comfortable speed lands in the scoring band.
  await flick(page, 2.45);
  await expect(page.locator('.freethrow-callout')).toHaveClass(/is-made/, { timeout: 4000 });
  await expect(page.locator('.freethrow-practice-stats')).toContainText('1/1');
  const power = Number(await page.locator('.freethrow-meter b').innerText());
  expect(power).toBeGreaterThanOrEqual(51);
  expect(power).toBeLessThanOrEqual(59);
  await expect(page.locator('.freethrow-aim b')).toHaveText('가운데');
  await page.screenshot({ path: 'docs/screenshots/freethrow-practice-made-390.png' });
  await idle(page);

  // Leaning hard to the left misses left, and the copy says so.
  await flick(page, 2.45, -0.6);
  await expect(page.locator('.freethrow-callout')).toHaveClass(/is-miss/, { timeout: 4000 });
  await expect(page.locator('.freethrow-callout strong')).toContainText('왼쪽');
  await expect(page.locator('.freethrow-aim b')).toContainText('왼쪽');
  await expect(page.locator('.freethrow-practice-stats')).toContainText('1/2');
  await idle(page);

  // Too gentle falls short.
  await flick(page, 1.0);
  await expect(page.locator('.freethrow-callout strong')).toHaveText('짧았어요', { timeout: 4000 });
  await idle(page);
  // Practice closes without asking.
  await page.getByRole('button', { name: '나가기' }).click();
  await expect(shell).toHaveCount(0);
  expect(api).toEqual([]);
});

test('free-throw sound preference survives a reload and the court fits short and wide screens', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 560, height: 980 });
  await page.goto('/#/preview/play/freethrow');
  await page.getByRole('button', { name: '연습하기' }).click();
  await expect(page.getByRole('button', { name: '소리 끄기' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '소리 끄기' }).click();
  await page.reload();
  await page.getByRole('button', { name: '연습하기' }).click();
  await expect(page.getByRole('button', { name: '소리 켜기' })).toHaveAttribute('aria-pressed', 'false');
  for (const [width, height] of [[560, 980], [390, 600], [1280, 720]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const box = (await canvas(page).boundingBox())!;
    expect(box.width / box.height).toBeCloseTo(360 / 560, 2);
    // Nothing scrolls: the court and the readout below it are on screen.
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    const readout = (await page.locator('.freethrow-readout').boundingBox())!;
    expect(readout.y + readout.height).toBeLessThanOrEqual(height);
    const size = await canvas(page).evaluate((element: HTMLCanvasElement) => ({ width: element.width, css: element.getBoundingClientRect().width }));
    expect(size.width).toBeGreaterThanOrEqual(Math.round(size.css));
  }
  await page.setViewportSize({ width: 560, height: 980 });
  await flick(page, 2.45);
  await expect(page.locator('.freethrow-callout')).toHaveClass(/is-made/, { timeout: 4000 });
  await page.screenshot({ path: 'docs/screenshots/freethrow-practice-made-560.png' });
});

test('an official preview set records all ten balls at the end and shows the result', async ({ page }) => {
  // Ten real throws with their flights take a while on a busy machine.
  test.setTimeout(60_000);
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview/play/freethrow');
  const gold = async () => Number((await page.locator('.game-toolbar .gold').innerText()).replace(/\D/g, ''));
  const before = await gold();
  await page.getByRole('button', { name: '세트 시작하기' }).click();
  await expect(page.getByRole('region', { name: '자유투 공식 도전' })).toBeVisible();
  // 1.3 falls short with margin above the too-slow cutoff even on a busy machine.
  const goals = await throwSet(page, i => (i % 2 ? 1.3 : 2.45));
  expect(goals).toBeGreaterThanOrEqual(1);
  const result = page.locator('.play-result-dialog');
  await expect(result).toContainText(`${goals}골 성공!`);
  await expect(result).toContainText('기록했어요');
  await page.screenshot({ path: 'docs/screenshots/freethrow-official-result-390.png' });
  await result.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.play-shell')).toHaveCount(0);
  await expect(page.locator('.freethrow-official')).toContainText(`${goals}골 성공!`);
  // The page behind scrolls again: nothing of the play view's lock is left.
  expect(await page.evaluate(() => [document.body.style.overflow, document.body.style.position, document.documentElement.style.overflowY, document.documentElement.dataset.playOpen ?? ''])).toEqual(['', '', '', '']);
  expect(await gold()).toBe(before + goals * 5);
  await expect(page.locator('.freethrow-today li.is-me')).toContainText(`${goals}골`);
  await page.getByRole('button', { name: '뒤로 가기' }).click();
  await expect(page.locator('.solo-tile', { hasText: '자유투 대결' })).toContainText(`이번 세트 ${goals}골`);
});

test('an official set on the server is recorded once at the end, even across a lost response and a reload', async ({ page }) => {
  // Ten real throws with their flights take a while on a busy machine.
  test.setTimeout(60_000);
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.72' });
  await page.setViewportSize({ width: 390, height: 844 });
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: 'http://localhost:8788', 'CF-Connecting-IP': '192.0.2.72' },
    data: { username: 'siwon', password: 'e2e-only-password-2026' },
  });
  expect(login.status()).toBe(200);
  await page.goto('/#/play/freethrow');
  const finishes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/freethrow/finish')) finishes.push(request.url()); });
  await page.getByRole('button', { name: '세트 시작하기' }).click();
  // Gentle throws fall short: the record changes, the shared fixture balances do not.
  // Nothing is sent while the set is being thrown.
  await page.route('**/api/freethrow/finish', route => route.abort());
  // 1.3 falls short with margin above the too-slow cutoff even on a busy machine.
  await throwSet(page, () => 1.3);
  const result = page.locator('.play-result-dialog');
  await expect(result).toContainText('0골 성공!');
  await expect(result).toContainText('기록을 보내지 못했어요', { timeout: 6000 });
  expect(finishes).toHaveLength(1);
  let state = await (await page.request.get('/api/freethrow')).json();
  expect(state.current).toMatchObject({ completed: false });
  expect(state.current.shots).toHaveLength(0);
  await page.unroute('**/api/freethrow/finish');
  // A reload re-sends the finished set before anything else.
  await page.reload();
  await expect(page.locator('.freethrow-official')).toContainText('0골 성공!', { timeout: 8000 });
  state = await (await page.request.get('/api/freethrow')).json();
  expect(state.current).toMatchObject({ completed: true, made: 0 });
  expect(state.current.shots.map((shot: { kind: string }) => shot.kind)).toEqual(Array(10).fill('short'));
  await page.goto('/#/');
  await expect(page.locator('.solo-tile', { hasText: '자유투 대결' })).toContainText('이번 세트 0골');
});

test('leaving an official set midway asks first and ends it unfinished', async ({ page }) => {
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview/play/freethrow');
  await page.getByRole('button', { name: '세트 시작하기' }).click();
  await flick(page, 1.3);
  await expect(decided(page)).toHaveCount(1, { timeout: 6000 });
  await idle(page);
  await page.getByRole('button', { name: '나가기' }).click();
  await expect(page.locator('.play-quit-dialog')).toContainText('미완료로 끝나요');
  await page.getByRole('button', { name: '계속 던지기' }).click();
  await expect(page.locator('.play-shell')).toBeVisible();
  await page.getByRole('button', { name: '나가기' }).click();
  await page.getByRole('button', { name: '그만두기' }).click();
  await expect(page.locator('.play-shell')).toHaveCount(0);
  await expect(page.locator('.freethrow-official')).toContainText('미완료로 끝났어요');
  await expect(page.getByRole('button', { name: '세트 시작하기' })).toHaveCount(0);
});
