import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { SLOT_RULES } from '../../shared/balance';
import type { BootstrapResponse, SlotResponse, SlotSpin, SlotSpinInput, SlotSymbol } from '../../shared/types';

const ORIGIN = 'http://localhost:8788';
const TODAY = '2026-11-04';
const NOW = '2026-11-04T10:00:00.000Z';
const JACKPOT: SlotSymbol[] = ['seven', 'seven', 'seven'];
const LOSS: SlotSymbol[] = ['banana', 'apple', 'grape'];
test.use({ serviceWorkers: 'block', deviceScaleFactor: 2 });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.71' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

function historical(id: string, date: string, hour: number, reels: SlotSymbol[], prize = 0): SlotSpin {
  return { id, requestId: id, reels, prize, cost: SLOT_RULES.price, date,
    createdAt: `${date}T${String(hour).padStart(2, '0')}:00:00+09:00` };
}
const sampleHistory = () => [
  historical('slot-today-loss', TODAY, 16, ['apple', 'seven', 'chamoe']),
  historical('slot-today-win', TODAY, 12, JACKPOT, SLOT_RULES.jackpotPrize),
  historical('slot-yesterday-loss', '2026-11-03', 14, ['watermelon', 'strawberry', 'grape']),
  historical('slot-older-loss', '2026-11-02', 9, ['banana', 'chamoe', 'banana']),
];
type Outcome = { reels: SlotSymbol[]; drop?: boolean; wait?: Promise<void> };
async function fixture(page: Page, options: { gold?: number; recent?: SlotSpin[] } = {}) {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.71' },
    data: { username: 'yeseo', password: 'e2e-only-password-2026' },
  });
  expect(login.status(), 'isolated local slot fixture login').toBe(200);
  const initial = await (await page.request.get('/api/bootstrap')).json() as BootstrapResponse;
  let snapshot: BootstrapResponse = { ...initial, serverTime: NOW, announcements: [], lottoNotice: null,
    user: { ...initial.user, gold: options.gold ?? 12000 }, inventory: { lottoTickets: 3, speettoTickets: 3, tagTickets: 0 } };
  const recent = options.recent ?? sampleHistory();
  const receipts = new Map<string, SlotSpin>();
  const attempts: SlotSpinInput[] = [];
  const outcomes: Outcome[] = [];
  let debits = 0;
  const state = () => ({ gold: snapshot.user.gold, inventory: snapshot.inventory, canPurchase: true, serverTime: NOW });
  await page.route('**/api/bootstrap', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/shop', route => route.fulfill({ json: state() }));
  await page.route('**/api/shop/slot', async route => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { ...state(), slot: { recent: recent.slice(0, SLOT_RULES.historyLimit) } } satisfies SlotResponse });
    }
    expect(route.request().method()).toBe('POST');
    const input = route.request().postDataJSON() as SlotSpinInput;
    expect(Object.keys(input)).toEqual(['requestId']);
    attempts.push(input);
    let spin = receipts.get(input.requestId);
    let outcome: Outcome | undefined;
    if (!spin) {
      expect(snapshot.user.gold).toBeGreaterThanOrEqual(SLOT_RULES.price);
      outcome = outcomes.shift() ?? { reels: LOSS };
      const prize = outcome.reels.every(symbol => symbol === 'seven') ? SLOT_RULES.jackpotPrize : 0;
      spin = historical(`slot-spin-${receipts.size + 1}`, TODAY, 19, [...outcome.reels], prize);
      spin.requestId = input.requestId;
      receipts.set(input.requestId, spin);
      recent.unshift(spin);
      debits++;
      snapshot = { ...snapshot, user: { ...snapshot.user, gold: snapshot.user.gold - SLOT_RULES.price + prize } };
    }
    await outcome?.wait;
    if (outcome?.drop) return route.abort('failed');
    return route.fulfill({ json: { ...state(), slot: { recent: recent.slice(0, SLOT_RULES.historyLimit) }, spin } satisfies SlotResponse });
  });
  return {
    accountId: snapshot.user.id,
    attempts, receipts, recent,
    get gold() { return snapshot.user.gold; },
    get debits() { return debits; },
    setGold(gold: number) { snapshot = { ...snapshot, user: { ...snapshot.user, gold } }; },
    queue(outcome: Outcome) { outcomes.push(outcome); },
  };
}
const machine = (page: Page) => page.locator('.slot-machine');
const reels = (page: Page) => page.locator('.slot-reel');
const play = (page: Page) => page.getByRole('button', { name: '돌리기 · 500G', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true });
async function go(page: Page, path: string) { await page.evaluate(value => { location.hash = value; }, path); }
async function ready(page: Page) {
  await expect(machine(page)).toBeVisible();
  await expect(play(page)).toBeEnabled();
  await expect(reels(page)).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
}
async function result(page: Page, expected: SlotSymbol[], phase: 'won' | 'lost') {
  await expect(machine(page)).toHaveAttribute('data-phase', phase);
  await expect.poll(() => reels(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-symbol')))).toEqual(expected);
  await expect.poll(() => page.locator('.slot-reel-face img').evaluateAll(images => images.map(image => image.getAttribute('src'))))
    .toEqual(expected.map(symbol => `/slot/${symbol}.svg`));
  expect(await reels(page).evaluateAll(nodes => nodes.every(node => node.getAttribute('data-spinning') === 'false'))).toBe(true);
}
async function capture(page: Page, name: string, width: number, info: TestInfo, spinning = false) {
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => image.getBoundingClientRect().height > 0)
    .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${width}px`).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  if (spinning) await machine(page).evaluate(node => {
    // Freeze a genuine looping frame, without resolving the held server response.
    for (const animation of node.getAnimations({ subtree: true })) {
      if (animation.effect?.getTiming().iterations === Infinity) { animation.currentTime = 90; animation.pause(); }
    }
  });
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/update-pr7-${name}-${width}.png`;
  await page.screenshot({ path, fullPage: true, scale: 'css', animations: spinning ? 'allow' : 'disabled' });
  await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
}

for (const width of [390, 560]) test(`slot tiles, motion states and purchase-day history at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width, height: 900 });
  const data = await fixture(page);
  await page.goto('/#/');
  const homeTile = page.locator('.shop-tile').filter({ hasText: '슬롯머신' });
  await expect(homeTile).toContainText('1회 500G');
  await expect(homeTile).not.toContainText('이용권');
  await expect(page.locator('.shop-tile')).toHaveCount(4); // + 별명 태그 뽑기 (PR 9)
  expect(await homeTile.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await capture(page, 'home-slot-tile', width, info);
  await go(page, '/shop');
  const shopTile = page.locator('.shop-tile').filter({ hasText: '슬롯머신' });
  await expect(shopTile).toContainText('1회 500G');
  await expect(page.locator('.shop-tile')).toHaveCount(4); // + 별명 태그 뽑기 (PR 9)
  await capture(page, 'shop-slot-tile', width, info);
  await shopTile.click();
  await expect(page).toHaveURL(/#\/shop\/slot$/);
  await ready(page);
  await expect(machine(page)).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('.tabbar')).toHaveCount(0);
  await expect(page.locator('.slot')).not.toContainText('이용권');
  await capture(page, 'slot-idle', width, info);

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  data.queue({ reels: JACKPOT, wait: held });
  await page.getByRole('button', { name: '슬롯머신 레버 당기기', exact: true }).click();
  await expect(machine(page)).toHaveAttribute('data-phase', 'spinning');
  await expect(page.locator('.slot-spin-button')).toBeDisabled();
  await expect.poll(() => data.attempts.length).toBe(1);
  expect(await reels(page).evaluateAll(nodes => nodes.every(node => node.getAttribute('data-spinning') === 'true'))).toBe(true);
  await capture(page, 'slot-spinning', width, info, true);
  release();
  await result(page, JACKPOT, 'won');
  await expect(page.locator('.slot-result')).toContainText('+2,000G');
  await expect(page.locator('.fx-coin')).toHaveCount(6);
  expect(await page.locator('.slot-bulbs').evaluate(node => node.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  await expect(page.locator('.game-toolbar .gold')).toContainText('13,500');
  await capture(page, 'slot-jackpot', width, info);

  data.queue({ reels: LOSS });
  await play(page).click();
  await result(page, LOSS, 'lost');
  await expect(page.locator('.slot-result')).toContainText('아쉬워요');
  await expect(page.locator('.game-toolbar .gold')).toContainText('13,000');
  await capture(page, 'slot-loss', width, info);
  await go(page, '/shop');
  await go(page, '/shop/slot');
  await ready(page);
  const history = page.locator('.slot-history');
  await expect(history.locator('.shop-history-group')).toHaveCount(3);
  await expect(history.locator('[data-purchase-date="2026-11-04"] .shop-history-heading strong')).toHaveText('당첨 +4,000G');
  await expect(history.locator('[data-purchase-date="2026-11-03"] .shop-history-heading strong')).toHaveCount(0);
  await expect(history.locator('[data-purchase-date="2026-11-02"] .shop-history-heading strong')).toHaveCount(0);
  await expect(history).toContainText('최근 7일');
  await capture(page, 'slot-history', width, info);
  expect(data.debits).toBe(2);
  expect(new Set(data.attempts.map(attempt => attempt.requestId)).size).toBe(2);
});

type TimingTrace = { clickedAt: number; requestedAt: number; starts: number[]; stops: number[]; phases: { phase: string; at: number }[] };
async function observeMotion(page: Page) {
  await page.addInitScript(() => {
    const observed = window as typeof window & { slotTiming: TimingTrace };
    observed.slotTiming = { clickedAt: 0, requestedAt: 0, starts: [], stops: [], phases: [] };
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element) || !event.target.closest('button')?.textContent?.includes('돌리기')) return;
      observed.slotTiming = { clickedAt: performance.now(), requestedAt: 0, starts: [], stops: [], phases: [] };
    }, true);
    const original = window.fetch;
    window.fetch = (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/shop/slot') && (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'POST') {
        observed.slotTiming.requestedAt = performance.now();
      }
      return original(...args);
    };
    new MutationObserver(() => {
      const trace = observed.slotTiming;
      if (!trace.clickedAt) return;
      const now = performance.now();
      const phase = document.querySelector('.slot-machine')?.getAttribute('data-phase');
      if (phase && trace.phases.at(-1)?.phase !== phase) trace.phases.push({ phase, at: now });
      document.querySelectorAll('.slot-reel').forEach((node, index) => {
        if (node.getAttribute('data-spinning') === 'true') trace.starts[index] ??= now;
        else if (trace.starts[index]) trace.stops[index] ??= now;
      });
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-phase', 'data-spinning', 'data-symbol'] });
  });
}
const trace = (page: Page) => page.evaluate(() => (window as typeof window & { slotTiming: TimingTrace }).slotTiming);

test('reels start with the request, stop on server symbols in order and slow the last 7-7 reel', async ({ page }) => {
  await observeMotion(page);
  const data = await fixture(page);
  await page.goto('/#/shop/slot');
  await ready(page);
  data.queue({ reels: LOSS });
  await play(page).click();
  await result(page, LOSS, 'lost');
  const normal = await trace(page);
  expect(normal.requestedAt - normal.clickedAt, 'POST starts in the click turn').toBeLessThan(100);
  expect(normal.starts).toHaveLength(3);
  expect(Math.max(...normal.starts) - Math.min(...normal.starts), 'all reels begin together').toBeLessThan(40);
  expect(normal.stops).toHaveLength(3);
  expect(normal.stops[0]! - normal.clickedAt).toBeGreaterThanOrEqual(780);
  for (const gap of [normal.stops[1]! - normal.stops[0]!, normal.stops[2]! - normal.stops[1]!]) {
    expect(gap).toBeGreaterThanOrEqual(300);
    expect(gap).toBeLessThan(480);
  }
  data.queue({ reels: ['seven', 'seven', 'chamoe'] });
  await play(page).click();
  await result(page, ['seven', 'seven', 'chamoe'], 'lost');
  const nearMiss = await trace(page);
  expect(nearMiss.stops).toHaveLength(3);
  const finalGap = nearMiss.stops[2]! - nearMiss.stops[1]!;
  expect(finalGap).toBeGreaterThanOrEqual(900);
  expect(finalGap).toBeLessThan(1100);
  expect(finalGap - (normal.stops[2]! - normal.stops[1]!)).toBeGreaterThanOrEqual(530);
  await expect(page.locator('.slot-result')).toContainText('아쉬워요');
});

test('reduced motion uses a short result fade without looping reels or lever motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await observeMotion(page);
  const data = await fixture(page);
  await page.goto('/#/shop/slot');
  await ready(page);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  data.queue({ reels: JACKPOT });
  const seen: { duration: number; frames: PropertyIndexedKeyframes | Keyframe[] }[] = [];
  await page.exposeFunction('recordSlotAnimation', (value: { duration: number; frames: PropertyIndexedKeyframes | Keyframe[] }) => seen.push(value));
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (this.closest('.slot-machine')) {
        const timing = typeof options === 'number' ? options : options?.duration;
        void (window as typeof window & { recordSlotAnimation: (value: unknown) => Promise<void> }).recordSlotAnimation({ duration: Number(timing), frames });
      }
      return original.call(this, frames, options);
    };
  });
  await play(page).click();
  await result(page, JACKPOT, 'won');
  const timing = await trace(page);
  expect(timing.starts).toHaveLength(0);
  expect(timing.phases.find(item => item.phase === 'won')!.at - timing.clickedAt).toBeGreaterThanOrEqual(170);
  expect(timing.phases.find(item => item.phase === 'won')!.at - timing.clickedAt).toBeLessThan(700);
  expect(await machine(page).evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity))).toBe(false);
  expect(seen.some(animation => animation.duration === 200), '200ms result fade is present').toBe(true);
  expect(seen.every(animation => !JSON.stringify(animation.frames).match(/translateY|rotate|translate\(/))).toBe(true);
});

test('a lost response keeps the same pending request across reload and retries below the spin price', async ({ page }) => {
  const data = await fixture(page, { gold: SLOT_RULES.price, recent: [] });
  data.queue({ reels: LOSS, drop: true });
  await page.goto('/#/shop/slot');
  await ready(page);
  await play(page).click();
  await expect(machine(page)).toHaveAttribute('data-phase', 'checking');
  await expect(page.locator('.slot-result')).toContainText('결과 확인 중');
  expect(await reels(page).evaluateAll(nodes => nodes.every(node => node.getAttribute('data-spinning') === 'false'))).toBe(true);
  expect(await machine(page).evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity))).toBe(false);
  await expect(retry(page)).toBeEnabled();
  expect(data.attempts).toHaveLength(1);
  expect(data.debits).toBe(1);
  expect(data.gold).toBe(0);
  await go(page, '/shop');
  await go(page, '/shop/slot');
  await page.reload();
  await expect(retry(page)).toBeEnabled();
  await expect(page.locator('.game-toolbar .gold')).toContainText('0');
  await retry(page).click();
  expect(await reels(page).evaluateAll(nodes => nodes.every(node => node.getAttribute('data-spinning') === 'false'))).toBe(true);
  expect(await machine(page).evaluate(node => node.getAnimations({ subtree: true }).some(animation => animation.effect?.getTiming().iterations === Infinity))).toBe(false);
  await result(page, LOSS, 'lost');
  expect(data.attempts).toHaveLength(2);
  expect(data.attempts[1]).toEqual(data.attempts[0]);
  expect(data.debits).toBe(1);
  expect(data.receipts.size).toBe(1);
  expect(data.gold).toBe(0);
  await expect(play(page)).toBeDisabled();
  await expect(page.locator('.slot')).toContainText('골드가 부족해요');
  await expect(retry(page)).toHaveCount(0);
});

for (const gold of [SLOT_RULES.price, SLOT_RULES.price * 2]) test(`a delayed response after leaving the screen keeps its original retry at ${gold}G`, async ({ page }) => {
  const data = await fixture(page, { gold, recent: [] });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  data.queue({ reels: LOSS, wait: held });
  try {
    await page.goto('/#/shop/slot');
    await ready(page);
    await play(page).click();
    await expect.poll(() => data.attempts.length).toBe(1);
    await expect(machine(page)).toHaveAttribute('data-phase', 'spinning');
    await go(page, '/shop');
    await expect(page.getByRole('heading', { name: '상점', exact: true })).toBeVisible();
    await go(page, '/shop/slot');
    await expect(machine(page)).toHaveAttribute('data-phase', 'checking');
    await expect(retry(page)).toBeDisabled();
    release();
    // A succeeded while the replacement screen was already mounted. Its
    // original input must outlive the provider's now-cleared pending entry.
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), `yegoom3:shop:pending:${data.accountId}`)).toBeNull();
    await expect(retry(page)).toBeEnabled();
    await expect(machine(page)).toHaveAttribute('data-phase', 'checking');
    expect(data.gold).toBe(gold - SLOT_RULES.price);
    await retry(page).click();
    await result(page, LOSS, 'lost');
    expect(data.attempts).toHaveLength(2);
    expect(data.attempts[1]).toEqual(data.attempts[0]);
    expect(data.debits).toBe(1);
    expect(data.receipts.size).toBe(1);
    expect(data.gold).toBe(gold - SLOT_RULES.price);
    await expect(page.locator('.game-toolbar .gold')).toContainText(data.gold.toLocaleString('ko-KR'));
  } finally { release(); }
});

test('confirming an old winning receipt keeps the current wallet after its prize was spent elsewhere', async ({ page }) => {
  const data = await fixture(page, { gold: SLOT_RULES.price, recent: [] });
  data.queue({ reels: JACKPOT, drop: true });
  await page.goto('/#/shop/slot');
  await ready(page);
  await play(page).click();
  await expect(machine(page)).toHaveAttribute('data-phase', 'checking');
  expect(data.gold).toBe(SLOT_RULES.jackpotPrize);
  expect(data.debits).toBe(1);
  // Another tab spent the already-credited prize before this tab confirms the
  // saved receipt. A replay carries today's wallet, not the original payout.
  data.setGold(100);
  await page.reload();
  await expect(retry(page)).toBeEnabled();
  await expect(page.locator('.game-toolbar .gold')).toContainText('100');
  await page.evaluate(() => {
    const observed = window as typeof window & { slotWalletValues: number[] };
    observed.slotWalletValues = [];
    const wallet = document.querySelector('.game-toolbar .gold')!;
    const record = () => {
      const text = (wallet.textContent ?? '').replace(/−/g, '-').replace(/[^\d-]/g, '');
      if (text) observed.slotWalletValues.push(Number(text));
    };
    record();
    new MutationObserver(record).observe(wallet, { childList: true, subtree: true, characterData: true });
  });
  await retry(page).click();
  await result(page, JACKPOT, 'won');
  await expect(page.locator('.game-toolbar .gold')).toContainText('100');
  const values = await page.evaluate(() => (window as typeof window & { slotWalletValues: number[] }).slotWalletValues);
  expect(values.length).toBeGreaterThan(0);
  expect(values.every(value => Number.isFinite(value) && value >= 0 && value <= 100), 'replaying a receipt never invents a debit or a second payout').toBe(true);
  expect(values.at(-1)).toBe(100);
  expect(data.attempts).toHaveLength(2);
  expect(data.attempts[1]).toEqual(data.attempts[0]);
  expect(data.debits).toBe(1);
  expect(data.receipts.size).toBe(1);
  expect(data.gold).toBe(100);
});

test('slot preview uses the same gold-only rules without any API requests', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto('/#/preview/shop/slot');
  await ready(page);
  const before = await page.locator('.game-toolbar .gold').innerText();
  await play(page).click();
  await result(page, JACKPOT, 'won');
  await expect(page.locator('.slot-result')).toContainText('+2,000G');
  const initialGold = Number(before.replace(/[^\d]/g, ''));
  await expect(page.locator('.game-toolbar .gold')).toContainText((initialGold - SLOT_RULES.price + SLOT_RULES.jackpotPrize).toLocaleString('ko-KR'));
  await expect(page.locator('.slot-history .shop-history-heading strong')).toHaveText('당첨 +2,000G');
  expect(requests).toEqual([]);
});
