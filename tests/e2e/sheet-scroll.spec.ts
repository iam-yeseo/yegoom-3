import { expect, test, type Locator, type Page } from '@playwright/test';

type Sample = { width: number; scrollHeight: number; height: number; documentHeight: number; documentWidth: number; rootWidth: number; bodyWidth: number; appTop: number; appLeft: number; moving: boolean };
type Probe = { samples: Sample[]; done: boolean };
type ProbeWindow = Window & typeof globalThis & { sheetProbe: Probe };

test.use({
  viewport: { width: 1280, height: 900 },
  launchOptions: {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--no-sandbox', '--disable-features=OverlayScrollbar'],
  },
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.setFixedTime(new Date('2026-10-30T00:00:00Z'));
});

async function classicScrollbar(page: Page) {
  await page.addStyleTag({ content: 'body { min-height: 2000px; } ::-webkit-scrollbar { width: 16px; height: 16px; }' });
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
    gutter: innerWidth - document.documentElement.clientWidth,
  }));
  // This assertion makes the regression exercise a real reserved scrollbar,
  // even on headless Linux, rather than silently testing overlay scrollbars.
  expect(metrics.gutter).toBeGreaterThan(0);
  return metrics;
}

async function sampleEntrance(page: Page, trigger: Locator, selector: string) {
  const scrollbar = await classicScrollbar(page);
  await trigger.scrollIntoViewIfNeeded();
  const before = { ...scrollbar, ...await page.evaluate(() => {
    const app = document.querySelector('.app-shell')!.getBoundingClientRect();
    return { rootWidth: document.documentElement.getBoundingClientRect().width, bodyWidth: document.body.getBoundingClientRect().width, appTop: app.top, appLeft: app.left, scrollX, scrollY };
  }) };
  await page.evaluate(selector => {
    const probe: Probe = { samples: [], done: false };
    (window as unknown as ProbeWindow).sheetProbe = probe;
    let started: number | null = null;
    const frame = (now: number) => {
      const dialog = document.querySelector<HTMLDialogElement>(selector);
      if (dialog?.open) {
        started ??= now;
        probe.samples.push({
          width: document.documentElement.clientWidth,
          scrollHeight: dialog.scrollHeight,
          height: dialog.clientHeight,
          documentHeight: document.documentElement.scrollHeight,
          documentWidth: document.documentElement.scrollWidth,
          rootWidth: document.documentElement.getBoundingClientRect().width,
          bodyWidth: document.body.getBoundingClientRect().width,
          appTop: document.querySelector('.app-shell')!.getBoundingClientRect().top,
          appLeft: document.querySelector('.app-shell')!.getBoundingClientRect().left,
          moving: dialog.getAnimations().some(animation => animation.playState === 'running'),
        });
      }
      if (started !== null && now - started >= 450) probe.done = true;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, selector);
  await trigger.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).sheetProbe.done)).toBe(true);
  const samples = await page.evaluate(() => (window as unknown as ProbeWindow).sheetProbe.samples);
  expect(samples.filter(sample => sample.moving).length).toBeGreaterThan(2);
  for (const sample of samples) {
    expect(sample.width).toBe(before.width);
    expect(sample.scrollHeight).toBeLessThanOrEqual(sample.height);
    expect(sample.documentWidth).toBeLessThanOrEqual(before.width);
    expect(sample.documentHeight).toBeLessThanOrEqual(before.height);
    expect(sample.rootWidth).toBe(before.rootWidth);
    expect(sample.bodyWidth).toBe(before.bodyWidth);
    expect(sample.appTop).toBeCloseTo(before.appTop, 0);
    expect(sample.appLeft).toBeCloseTo(before.appLeft, 0);
  }
  await page.mouse.move(20, 300);
  await page.mouse.wheel(0, 400);
  await page.evaluate(() => window.scrollTo(200, 400));
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: 0, y: 0 });
  expect(await page.locator('.app-shell').evaluate(node => node.getBoundingClientRect().top)).toBeCloseTo(before.appTop, 0);
  return before;
}

async function closeAndRestore(page: Page, trigger: Locator, before: { scrollX: number; scrollY: number }) {
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({ x: before.scrollX, y: before.scrollY });
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  expect(await page.evaluate(() => document.body.style.position)).toBe('');
}

async function previewDrawing(page: Page) {
  await page.goto('/#/preview/play/catchmind');
  await page.getByRole('textbox', { name: '캐치마인드 정답', exact: true }).fill('선 인 장');
  await page.getByRole('button', { name: '정답', exact: true }).click();
  await page.getByRole('button', { name: '다음 그림 그리기', exact: true }).click();
  await expect(page.getByLabel('그림 그리는 캔버스', { exact: true })).toBeVisible();
}

test('desktop sheets do not create transient scrollbars or shift the page while entering', async ({ page }) => {
  await page.goto('/#/preview/play/kuji');
  const kujiTrigger = page.getByRole('button', { name: 'A상 보상 보기', exact: true });
  const kujiBefore = await sampleEntrance(page, kujiTrigger, '.kuji-modal');
  await closeAndRestore(page, kujiTrigger, kujiBefore);

  await previewDrawing(page);
  const colorTrigger = page.getByRole('button', { name: '색상 고르기', exact: true });
  const colorBefore = await sampleEntrance(page, colorTrigger, '.color-picker-dialog');
  await closeAndRestore(page, colorTrigger, colorBefore);

  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.24' });
  await page.goto('/');
  await page.getByLabel('아이디', { exact: true }).fill('min');
  await page.getByLabel('비밀번호', { exact: true }).fill('e2e-only-password-2026');
  await page.getByRole('button', { name: '예굼방 들어가기', exact: true }).click();
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '내 정보', exact: true }).click();
  const passwordTrigger = page.getByRole('button', { name: '비밀번호 변경', exact: true });
  const passwordBefore = await sampleEntrance(page, passwordTrigger, '.password-dialog');
  // A file chooser can finish after another modal opens. Closing the resulting
  // photo sheet must leave the underlying password sheet's page lock intact.
  await page.locator('.profile-photo-input').setInputFiles('tests/fixtures/photo-square.webp');
  const photo = page.getByRole('dialog', { name: '프로필 사진 자르기', exact: true });
  await expect(photo).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(photo).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '비밀번호 변경', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  expect(await page.evaluate(() => document.body.style.position)).toBe('fixed');
  await closeAndRestore(page, passwordTrigger, passwordBefore);
});

test('a short viewport keeps real sheet content scrollable after opening and reopening', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 360 });
  await previewDrawing(page);
  const before = await classicScrollbar(page);
  const trigger = page.getByRole('button', { name: '색상 고르기', exact: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '색상 고르기', exact: true });
    await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    const metrics = await dialog.evaluate(node => {
      node.scrollTop = node.scrollHeight;
      return { scrollHeight: node.scrollHeight, height: node.clientHeight, top: node.scrollTop, overflow: getComputedStyle(node).overflowY, overscroll: getComputedStyle(node).overscrollBehaviorY };
    });
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
    expect(metrics.top).toBeGreaterThan(0);
    expect(metrics.overflow).toBe('auto');
    expect(metrics.overscroll).toBe('contain');
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(before.width);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  }
});

test('browser back from a scrolled modal leaves the destination at the top and restores page styles', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto('/#/preview');
  await page.locator('.game-row').filter({ hasText: '예굼쿠지' }).click();
  await expect(page).toHaveURL(/#\/preview\/play\/kuji$/);
  const trigger = page.getByRole('button', { name: '라스트원 보상 보기', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await trigger.click();
  await expect(page.getByRole('dialog', { name: '라스트원 보상', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.position)).toBe('fixed');

  await page.goBack();
  await expect(page).toHaveURL(/#\/preview$/);
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => ({
    x: scrollX, y: scrollY,
    position: document.body.style.position, top: document.body.style.top,
    left: document.body.style.left, width: document.body.style.width,
    overflow: document.body.style.overflow, rootOverflowY: document.documentElement.style.overflowY,
  }))).toEqual({ x: 0, y: 0, position: '', top: '', left: '', width: '', overflow: '', rootOverflowY: '' });
});
