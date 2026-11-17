import { mkdir } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse, LottoResponse, LottoTicket, SpeettoResponse, SpeettoTicket } from '../../shared/types';

const ORIGIN = 'http://localhost:8788';
const TODAY = '2026-11-04';
const NOW = '2026-11-04T10:00:00.000Z'; // 19:00 KST, including a purchase for tomorrow.
const WINNING = [1, 2, 3, 4, 5];
test.use({ serviceWorkers: 'block', deviceScaleFactor: 3 });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.31' });
});

async function signIn(page: Page, username = 'yeseo'): Promise<BootstrapResponse> {
  const login = await page.request.post('/api/auth/login', {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.31' },
    data: { username, password: 'e2e-only-password-2026' },
  });
  expect(login.status(), 'isolated shop fixture login').toBe(200);
  const response = await page.request.get('/api/bootstrap');
  expect(response.status()).toBe(200);
  return response.json();
}
function lotto(id: string, purchaseDate: string, drawDate: string, hour: number, numbers: number[], matches: number | null, rank: number | null, prize: number | null): LottoTicket {
  return { id, requestId: id, purchaseDate, createdAt: `${purchaseDate}T${String(hour).padStart(2, '0')}:00:00+09:00`, drawDate, numbers,
    payment: 'gold', cost: 500, winningNumbers: matches === null ? null : WINNING, matches, rank, prize };
}
const lottoTickets = () => [
  lotto('lotto-tomorrow', TODAY, '2026-11-05', 18, [21, 22, 23, 24, 25], null, null, null),
  lotto('lotto-today-lost', TODAY, TODAY, 15, [11, 12, 13, 14, 15], 0, null, 0),
  lotto('lotto-today-won', TODAY, TODAY, 10, WINNING, 5, 1, 5000),
  lotto('lotto-yesterday-late', '2026-11-03', TODAY, 18, WINNING, 5, 1, 5000),
  lotto('lotto-older', '2026-11-02', '2026-11-02', 11, [1, 2, 21, 22, 23], 2, 4, 500),
];
function speetto(id: string, date: string, hour: number, won: boolean): SpeettoTicket {
  return { id, requestId: id, purchaseDate: date, createdAt: `${date}T${String(hour).padStart(2, '0')}:00:00+09:00`,
    cells: won ? ['cat', 'cat', 'cat'] : ['cat', 'drop', 'bread'], won, prize: won ? 1500 : 0, payment: 'gold', cost: 300, revealed: false };
}
// The server lists only today's speetto tickets, newest first.
const speettoTickets = () => [
  speetto('00000000-0000-4000-8000-000000000101', TODAY, 16, true), speetto('00000000-0000-4000-8000-000000000102', TODAY, 12, false),
];
async function fixture(page: Page, tickets: { lotto?: LottoTicket[]; speetto?: SpeettoTicket[] } = {}) {
  const initial = await signIn(page);
  let snapshot: BootstrapResponse = { ...initial, notifications: { unread: 0, recent: [] }, serverTime: NOW,
    user: { ...initial.user, gold: 12000 }, inventory: { lottoTickets: 3, speettoTickets: 3, tagTickets: 0 },
    lottoNotice: { drawDate: TODAY, tickets: 3, winners: 2, prize: 10000 } };
  const writes: string[] = [];
  /** Tickets scratched open, in order: the one write scratching makes. */
  const reveals: string[] = [];
  const speettoList = tickets.speetto ?? speettoTickets();
  const speettoResponse = (): SpeettoResponse => ({ gold: snapshot.user.gold, inventory: snapshot.inventory, canPurchase: true, serverTime: snapshot.serverTime,
    speetto: { tickets: speettoList } });
  await page.route('**/api/bootstrap', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/shop/lotto', route => {
    if (route.request().method() !== 'GET') { writes.push(route.request().url()); return route.abort(); }
    const response: LottoResponse = { gold: snapshot.user.gold, inventory: snapshot.inventory, canPurchase: true, serverTime: snapshot.serverTime,
      lotto: { targetDrawDate: Date.parse(snapshot.serverTime) < Date.parse(`${TODAY}T17:30:00+09:00`) ? TODAY : '2026-11-05',
        todayDraw: { date: TODAY, numbers: Date.parse(snapshot.serverTime) >= Date.parse(`${TODAY}T17:30:00+09:00`) ? WINNING : null }, tickets: tickets.lotto ?? lottoTickets() } };
    return route.fulfill({ json: response });
  });
  await page.route('**/api/shop/speetto', route => {
    if (route.request().method() !== 'GET') { writes.push(route.request().url()); return route.abort(); }
    return route.fulfill({ json: speettoResponse() });
  });
  // Scratching is saved on the server; the fixture keeps it like the Worker does.
  await page.route('**/api/shop/speetto/reveal', route => {
    const { ticketId } = route.request().postDataJSON() as { ticketId: string };
    const ticket = speettoList.find(entry => entry.id === ticketId);
    if (route.request().method() !== 'POST' || !ticket) { writes.push(route.request().url()); return route.abort(); }
    reveals.push(ticketId);
    ticket.revealed = true;
    return route.fulfill({ json: speettoResponse() });
  });
  return {
    get snapshot() { return snapshot; }, writes, reveals,
    replace(next: Partial<BootstrapResponse>) { snapshot = { ...snapshot, ...next }; },
    async switchAccount(username: string) {
      const next = await signIn(page, username);
      snapshot = { ...snapshot, user: { ...next.user, gold: 12000 }, players: next.players };
    },
  };
}
const notice = (page: Page) => page.getByRole('region', { name: '데일리 로또 결과 안내', exact: true });
const cover = (page: Page) => page.locator('.scratch-area canvas');
async function go(page: Page, path: string) { await page.evaluate(value => { location.hash = value; }, path); }
async function readyCover(page: Page) {
  await expect(cover(page)).toBeVisible();
  await expect(cover(page)).toHaveAttribute('aria-busy', 'false');
}
async function capture(page: Page, name: string, width: number, info: TestInfo) {
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.locator('img').evaluateAll(images => images.filter(image => image.getBoundingClientRect().height > 0)
    .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect(page.locator('.fx-toast, .announcement-banner')).toHaveCount(0);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${width}px`).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await mkdir('docs/screenshots', { recursive: true });
  const path = `docs/screenshots/update-pr6-${name}-${width}.png`;
  await page.screenshot({ path, fullPage: true, scale: 'css', animations: 'disabled' });
  await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
}
const drawDialog = (page: Page) => page.locator('dialog.lotto-draw-dialog');
const resultDialog = (page: Page) => page.locator('dialog.speetto-result-dialog');
const drawShownKey = (accountKey: string, date = TODAY) => `yegoom3:lotto-draw-shown:${accountKey}:${date}`;
/** Closes the scratch result modal after checking what it announces. */
async function confirmResult(page: Page, text: string) {
  await expect(resultDialog(page)).toHaveAccessibleName('스피또 결과');
  await expect(resultDialog(page).locator('h2')).toHaveText(text);
  await resultDialog(page).getByRole('button', { name: '확인', exact: true }).click();
  await expect(resultDialog(page)).toHaveCount(0);
}
/** One pay button, in the bar pinned to the bottom of the viewport: an 이용권
 * while any is held, so no gold button next to it. */
async function oneTicketButton(page: Page) {
  const bar = page.locator('body > .shop-buy-bar');
  const actions = bar.locator('.shop-purchase-actions');
  await expect(actions.getByRole('button')).toHaveCount(1);
  await expect(page.locator('.shop-purchase-actions')).toHaveCount(1);
  await expect(actions.getByRole('button', { name: /^이용권으로 사기 · 1장 · 보유 \d+장$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^골드로 사기/ })).toHaveCount(0);
  const layout = await bar.evaluate(node => {
    const box = node.getBoundingClientRect(), button = node.querySelector('button')!, inner = button.getBoundingClientRect();
    return { position: getComputedStyle(node).position, bottom: box.bottom, left: box.left, right: box.right, viewportHeight: innerHeight, viewportWidth: innerWidth,
      buttonInside: inner.top >= box.top && inner.bottom <= box.bottom && inner.left >= box.left && inner.right <= box.right,
      overflow: button.scrollWidth > button.clientWidth };
  });
  expect(layout.position).toBe('fixed');
  expect(Math.abs(layout.bottom - layout.viewportHeight)).toBeLessThan(1);
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.buttonInside).toBe(true);
  expect(layout.overflow).toBe(false);
}
async function scratchLine(page: Page, from: [number, number], to: [number, number], steps = 5) {
  await cover(page).scrollIntoViewIfNeeded();
  const rect = (await cover(page).boundingBox())!;
  await page.mouse.move(rect.x + rect.width * from[0], rect.y + rect.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * to[0], rect.y + rect.height * to[1], { steps });
  await page.mouse.up();
}

for (const width of [390, 560]) test(`home notice, one pinned pay button, folded lotto days and today's speetto at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width, height: 900 });
  const data = await fixture(page);
  await page.goto('/#/');
  await expect(notice(page)).toContainText('오늘 산 데일리 로또 3장의 추첨이 끝났어요');
  await expect(notice(page)).not.toContainText(/10,000|6,000|5,000|1,000|당첨금|1등/);
  expect(await notice(page).evaluate(node => {
    const attendance = document.querySelector('.attendance-card');
    return Boolean(attendance && attendance.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await capture(page, 'home-lotto-notice', width, info);
  await notice(page).getByRole('button', { name: /^오늘 산/ }).click();
  await expect(page).toHaveURL(/#\/shop\/lotto$/);
  // The first visit after the draw opens today's numbers in a modal, once.
  await expect(drawDialog(page)).toBeVisible();
  await expect(drawDialog(page)).toHaveAccessibleName('데일리 로또 당첨 번호');
  await expect(drawDialog(page).locator('.draw-balls i')).toHaveText(WINNING.map(String));
  await expect(drawDialog(page).locator('.lotto-draw-summary')).toContainText('1등 당첨! +10,000G');
  await expect(drawDialog(page).locator('.lotto-draw-summary')).toContainText('내 표 3장 중 2장이 당첨됐어요.');
  expect(await page.evaluate(key => localStorage.getItem(key), drawShownKey(data.snapshot.user.id))).toBe('1');
  await drawDialog(page).getByRole('button', { name: '확인', exact: true }).click();
  await expect(drawDialog(page)).toHaveCount(0);
  await expect(page.locator('.lotto-meta')).toContainText('17시 30분');
  // The same numbers stay on the page, above the picker.
  const drawCard = page.locator('.lotto-draw');
  await expect(drawCard.locator('.draw-balls i')).toHaveText(WINNING.map(String));
  expect(await drawCard.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.lotto-picker')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  for (const number of [6, 7, 8, 9, 10]) await page.getByRole('button', { name: `번호 ${number}`, exact: true }).click();
  await expect(page.locator('.balls button[aria-pressed="true"][style]')).toHaveCount(5);
  await oneTicketButton(page);
  await expect(page.getByRole('button', { name: /^이용권으로 사기 · 1장/ })).toBeEnabled();
  await capture(page, 'lotto-buttons', width, info);
  const lottoHistory = page.locator('.lotto-tickets.shop-ticket-history');
  const day = (date: string) => lottoHistory.locator(`details.shop-history-group[data-purchase-date="${date}"]`);
  await expect(lottoHistory.locator('.shop-history-group')).toHaveCount(3);
  // Every purchase day starts folded: its heading only, no ticket rows.
  await expect(lottoHistory.locator('details.shop-history-group[open]')).toHaveCount(0);
  await expect(lottoHistory.locator('.ticket')).toHaveCount(0);
  await expect(day('2026-11-04')).toContainText('3장');
  await expect(day('2026-11-04').locator('.shop-history-heading strong')).toHaveText('당첨 +5,000G');
  await expect(day('2026-11-03').locator('.shop-history-heading strong')).toHaveText('당첨 +5,000G');
  await day('2026-11-04').locator('summary').click();
  await expect(day('2026-11-04').locator('.ticket')).toHaveCount(3);
  await expect(lottoHistory.locator('.ticket')).toHaveCount(3);
  await day('2026-11-03').locator('summary').click();
  await day('2026-11-02').locator('summary').click();
  await expect(lottoHistory.locator('.ticket')).toHaveCount(5);
  await expect(lottoHistory.locator('.ticket.card')).toHaveCount(0);
  await expect(lottoHistory.locator('[data-ticket-id="lotto-tomorrow"] .ticket-date')).toContainText('11월 05일 추첨');
  await expect(lottoHistory.locator('[data-ticket-id="lotto-yesterday-late"] .ticket-result')).toContainText('1등 · +5,000G');
  await expect(lottoHistory.locator('[data-ticket-id="lotto-yesterday-late"] .ticket-date')).toContainText('11월 04일 추첨');
  await expect(lottoHistory).toContainText('최근 7일 기록만 보여요');
  await capture(page, 'lotto-history', width, info);
  // Folding a day again takes its rows away.
  await day('2026-11-02').locator('summary').click();
  await expect(lottoHistory.locator('.ticket')).toHaveCount(4);
  // A second visit does not open the draw modal again; the card can replay it.
  await page.reload();
  await expect(drawCard).toBeVisible();
  await expect(drawDialog(page)).toHaveCount(0);
  await drawCard.getByRole('button', { name: '추첨 다시 보기', exact: true }).click();
  await expect(drawDialog(page)).toBeVisible();
  await drawDialog(page).getByRole('button', { name: '확인', exact: true }).click();
  await expect(drawDialog(page)).toHaveCount(0);

  await go(page, '/shop/speetto');
  await readyCover(page);
  await oneTicketButton(page);
  await capture(page, 'speetto-buttons', width, info);
  const first = '00000000-0000-4000-8000-000000000101', second = '00000000-0000-4000-8000-000000000102';
  const history = page.getByRole('region', { name: '오늘의 스피또', exact: true });
  const total = history.locator('.shop-history-heading strong');
  await expect(history).toHaveClass(/speetto-history/);
  await expect(history.locator('.shop-history-group')).toHaveCount(0);
  await expect(history.locator('h2')).toHaveText('오늘의 스피또 2장');
  await expect(history.locator('.speetto-ticket-row')).toHaveCount(2);
  // Newest first, numbered from the oldest.
  await expect(history.locator('.speetto-ticket-row .shop-ticket-order')).toHaveText(['2', '1']);
  await expect(history.getByText('긁기 전', { exact: true })).toHaveCount(2);
  await expect(total).toHaveCount(0);
  // The newest ticket still covered is the one offered.
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', first);
  await expect(page.locator('.scratch-result')).toHaveCount(0);
  await capture(page, 'scratch-before', width, info);
  await scratchLine(page, [.15, .48], [.55, .48]);
  // A partial scratch reveals nothing yet: still covered, no result, nothing saved.
  await expect(cover(page)).not.toHaveClass(/revealed/);
  await expect(resultDialog(page)).toHaveCount(0);
  await expect(history.locator(`[data-ticket-id="${first}"]`)).toContainText('긁기 전');
  expect(data.reveals).toEqual([]);
  await capture(page, 'scratch-partial', width, info);
  await page.getByRole('button', { name: '한 번에 긁기', exact: true }).click();
  await expect(cover(page)).toHaveClass(/revealed/);
  await confirmResult(page, '당첨! +1,500G');
  await expect(page.getByRole('button', { name: '한 번에 긁기', exact: true })).toHaveCount(0);
  await expect(history.locator(`[data-ticket-id="${first}"]`)).toContainText('+1,500G');
  await expect(total).toHaveText('당첨 +1,500G');
  await history.locator(`[data-ticket-id="${second}"]`).click();
  await readyCover(page);
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', second);
  await expect(cover(page)).not.toHaveClass(/revealed/);
  await page.getByRole('button', { name: '한 번에 긁기', exact: true }).click();
  await confirmResult(page, '아쉽지만 낙첨이에요');
  await expect(history.locator(`[data-ticket-id="${second}"]`)).toContainText('낙첨');
  // Going back to a scratched ticket shows it open and announces nothing again.
  await history.locator(`[data-ticket-id="${first}"]`).click();
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', first);
  await expect(cover(page)).toHaveClass(/revealed/);
  await expect(page.getByRole('button', { name: '한 번에 긁기', exact: true })).toHaveCount(0);
  await expect(resultDialog(page)).toHaveCount(0);
  await expect(total).toHaveText('당첨 +1,500G');
  await expect(history).toContainText('오늘 산 표만 보여요');
  await capture(page, 'speetto-history', width, info);
  await expect(page.locator('.game-toolbar .gold')).toContainText(data.snapshot.user.gold.toLocaleString('ko-KR'));
  // Scratching saved each ticket once and bought nothing.
  await expect.poll(() => data.reveals).toEqual([first, second]);
  // The server remembers: after a reload both stay scratched, with no modal.
  await page.reload();
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', first);
  await expect(cover(page)).toHaveClass(/revealed/);
  await expect(history.locator('.speetto-ticket-row strong')).toHaveText(['+1,500G', '낙첨']);
  await expect(total).toHaveText('당첨 +1,500G');
  await expect(page.getByRole('button', { name: '한 번에 긁기', exact: true })).toHaveCount(0);
  await expect(resultDialog(page)).toHaveCount(0);
  expect(data.reveals).toEqual([first, second]);
  expect(data.writes).toEqual([]);
});

test('history headings hide zero totals and count only revealed speetto wins', async ({ page }) => {
  const firstWin = '00000000-0000-4000-8000-000000000101';
  const loss = '00000000-0000-4000-8000-000000000102';
  const secondWin = '00000000-0000-4000-8000-000000000105';
  const data = await fixture(page, {
    lotto: [
      lotto('lotto-pending', TODAY, '2026-11-05', 18, [21, 22, 23, 24, 25], null, null, null),
      lotto('lotto-lost', '2026-11-03', '2026-11-03', 15, [11, 12, 13, 14, 15], 0, null, 0),
    ],
    speetto: [speetto(firstWin, TODAY, 16, true), speetto(loss, TODAY, 12, false), speetto(secondWin, TODAY, 10, true)],
  });
  // This device already saw today's draw: no modal covers the page.
  await page.addInitScript(key => { localStorage.setItem(key, '1'); }, drawShownKey(data.snapshot.user.id));
  await page.goto('/#/shop/lotto');
  const lottoHistory = page.locator('.lotto-tickets.shop-ticket-history');
  await expect(lottoHistory.locator('.shop-history-group')).toHaveCount(2);
  await expect(drawDialog(page)).toHaveCount(0);
  await expect(lottoHistory.locator('.shop-history-heading strong')).toHaveCount(0);
  await expect(lottoHistory.locator('.ticket')).toHaveCount(0);
  for (const date of [TODAY, '2026-11-03']) await lottoHistory.locator(`[data-purchase-date="${date}"] summary`).click();
  await expect(lottoHistory.locator('[data-ticket-id="lotto-pending"] .ticket-result')).toHaveText('추첨 대기');
  await expect(lottoHistory.locator('[data-ticket-id="lotto-lost"] .ticket-result')).toHaveText('낙첨');

  await go(page, '/shop/speetto');
  await readyCover(page);
  const history = page.locator('.speetto-history.shop-ticket-history');
  const todayTotal = history.locator('.shop-history-heading strong');
  const row = (id: string) => history.locator(`[data-ticket-id="${id}"]`);
  const reveal = async (id: string, text: string) => {
    await row(id).click();
    await readyCover(page);
    await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', id);
    await page.getByRole('button', { name: '한 번에 긁기', exact: true }).click();
    await confirmResult(page, text);
  };
  await expect(history.locator('.speetto-ticket-row .shop-ticket-order')).toHaveText(['3', '2', '1']);
  await expect(history.getByText('긁기 전', { exact: true })).toHaveCount(3);
  await expect(todayTotal).toHaveCount(0);
  await reveal(loss, '아쉽지만 낙첨이에요');
  await expect(row(loss)).toContainText('낙첨');
  await expect(todayTotal).toHaveCount(0);
  await expect(row(firstWin)).toContainText('긁기 전');
  await expect(row(secondWin)).toContainText('긁기 전');

  await reveal(firstWin, '당첨! +1,500G');
  await expect(todayTotal).toHaveText('당첨 +1,500G');
  await expect(row(secondWin)).toContainText('긁기 전');
  await row(secondWin).click();
  await readyCover(page);
  await expect(cover(page)).not.toHaveClass(/revealed/);
  await expect(resultDialog(page)).toHaveCount(0);
  await expect(todayTotal).toHaveText('당첨 +1,500G');
  await page.getByRole('button', { name: '한 번에 긁기', exact: true }).click();
  await confirmResult(page, '당첨! +1,500G');
  await expect(todayTotal).toHaveText('당첨 +3,000G');
  await row(firstWin).click();
  await expect(page.locator('.scratch-card')).toHaveAttribute('data-ticket-id', firstWin);
  await expect(cover(page)).toHaveClass(/revealed/);
  await expect(resultDialog(page)).toHaveCount(0);
  await expect(todayTotal).toHaveText('당첨 +3,000G');
  // Each scratch was saved once; nothing was bought.
  await expect.poll(() => data.reveals).toEqual([loss, firstWin, secondWin]);
  expect(data.writes).toEqual([]);
});

test('lotto notice dismissal is scoped to account and draw date and entry also marks it seen', async ({ page }) => {
  const data = await fixture(page);
  const earlyKey = `yegoom3:lotto-seen:${data.snapshot.user.id}:${TODAY}`;
  data.replace({ serverTime: `${TODAY}T17:29:59+09:00`, lottoNotice: null });
  await page.clock.setFixedTime(new Date(`${TODAY}T17:29:59+09:00`));
  await page.goto('/#/shop/lotto');
  await expect(page.locator('.lotto-target')).toContainText('2026년 11월 04일');
  expect(await page.evaluate(key => localStorage.getItem(key), earlyKey)).toBeNull();
  // Leave before advancing time; an open lotto page correctly sees the draw
  // at the boundary and would otherwise mark that newly viewed result seen.
  await page.goto('/#/');
  await expect(page.locator('.home')).toBeVisible();
  data.replace({ serverTime: NOW, lottoNotice: { drawDate: TODAY, tickets: 3, winners: 2, prize: 10000 } });
  await page.clock.setFixedTime(new Date(NOW));
  await page.reload();
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole('button', { name: '데일리 로또 안내 닫기', exact: true }).click();
  const yeseoKey = `yegoom3:lotto-seen:${data.snapshot.user.id}:${TODAY}`;
  expect(await page.evaluate(key => localStorage.getItem(key), yeseoKey)).not.toBeNull();
  await page.reload();
  await expect(notice(page)).toHaveCount(0);
  await data.switchAccount('min');
  await page.reload();
  await expect(notice(page)).toBeVisible();
  // The shop response can arrive before bootstrap contains its notice.
  data.replace({ lottoNotice: null });
  await page.reload();
  await expect(notice(page)).toHaveCount(0);
  await go(page, '/shop/lotto');
  await expect(page.getByRole('heading', { name: '데일리 로또', exact: true })).toBeVisible();
  const minKey = `yegoom3:lotto-seen:${data.snapshot.user.id}:${TODAY}`;
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), minKey)).not.toBeNull();
  data.replace({ lottoNotice: { drawDate: TODAY, tickets: 3, winners: 2, prize: 10000 } });
  await go(page, '/');
  await expect(notice(page)).toHaveCount(0);
  data.replace({ serverTime: '2026-11-05T00:00:00+09:00', lottoNotice: null });
  await page.clock.setFixedTime(new Date('2026-11-05T00:00:00+09:00'));
  await page.reload();
  await expect(notice(page)).toHaveCount(0);
  data.replace({ serverTime: '2026-11-05T19:00:00+09:00', lottoNotice: { drawDate: '2026-11-05', tickets: 2, winners: 0, prize: 0 } });
  await page.clock.setFixedTime(new Date('2026-11-05T19:00:00+09:00'));
  await page.reload();
  await expect(notice(page)).toContainText('2장의 추첨이 끝났어요');
});

test('blocked localStorage keeps notice navigation and closing usable without cross-reload persistence', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('yegoom3:lotto-seen:')) throw new DOMException('Fixture blocked storage', 'SecurityError');
      return set.call(this, key, value);
    };
  });
  await fixture(page);
  await page.goto('/#/');
  await notice(page).getByRole('button', { name: '데일리 로또 안내 닫기', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  await page.reload();
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole('button', { name: /^오늘 산/ }).click();
  await expect(page).toHaveURL(/#\/shop\/lotto$/);
});

test('preview lotto notice and 17:30 cards stay serverless and keep each schedule on one line', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto('/#/preview');
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole('button', { name: /^오늘 산/ }).click();
  await expect(page.locator('.lotto-meta')).toContainText('17시 30분');
  await go(page, '/preview');
  await expect(notice(page)).toHaveCount(0);
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const schedule = page.locator('.home-schedule').filter({ hasText: '17시 30분 추첨' });
    await expect(schedule).toBeVisible();
    const layout = await schedule.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const lines = new Set(Array.from(range.getClientRects()).filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
      const box = node.getBoundingClientRect(), parent = node.closest('.card')!.getBoundingClientRect();
      return { lines: lines.size, contained: box.left >= parent.left && box.right <= parent.right };
    });
    expect(layout).toEqual({ lines: 1, contained: true });
  }
  expect(requests).toEqual([]);
});

declare global {
  interface Window { __pr6ScratchLabels: { measuredPixels: number; width: number; fontReady: boolean; scaleX: number; scaleY: number }[] }
}
test('scratch cover uses actual pixels and font metrics, and keeps scratched pixels across a resize', async ({ page }) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    window.__pr6ScratchLabels = [];
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth?) {
      if (text === '여기를 긁어보세요') {
        const matrix = this.getTransform();
        window.__pr6ScratchLabels.push({ measuredPixels: this.measureText(text).width * Math.abs(matrix.a), width: this.canvas.width,
          fontReady: document.fonts.check('800 20px TmoneyRoundWind'), scaleX: matrix.a, scaleY: matrix.d });
      }
      if (maxWidth === undefined) return fill.call(this, text, x, y);
      return fill.call(this, text, x, y, maxWidth);
    };
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await fixture(page);
  await page.goto('/#/shop/speetto');
  await readyCover(page);
  const dimensions = () => cover(page).evaluate((node: HTMLCanvasElement) => {
    const box = node.getBoundingClientRect();
    return { width: node.width, height: node.height, cssWidth: box.width, cssHeight: box.height, dpr: devicePixelRatio };
  });
  async function checkDimensions() {
    await expect.poll(async () => {
      const d = await dimensions();
      return d.width === Math.round(d.cssWidth * 2) && d.height === Math.round(d.cssHeight * 2);
    }).toBe(true);
    const d = await dimensions();
    expect(d.dpr).toBe(3);
    expect(Math.abs(d.width / d.cssWidth - d.height / d.cssHeight)).toBeLessThan(.01);
    const labels = await page.evaluate(() => window.__pr6ScratchLabels);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.at(-1)!.fontReady).toBe(true);
    expect(labels.at(-1)!.measuredPixels).toBeLessThanOrEqual(labels.at(-1)!.width * .8 + 1);
  }
  await checkDimensions();
  const first = await dimensions();
  await page.setViewportSize({ width: 560, height: 900 });
  await checkDimensions();
  expect((await dimensions()).width).toBeGreaterThan(first.width);
  await page.locator('.scratch-area').evaluate(node => { (node as HTMLElement).style.width = '120px'; });
  await checkDimensions();
  expect((await dimensions()).cssWidth).toBe(120);
  await page.locator('.scratch-area').evaluate(node => { (node as HTMLElement).style.removeProperty('width'); });
  await checkDimensions();
  async function alpha(x: number, y: number, dx = 0, dy = 0) {
    return cover(page).evaluate((node: HTMLCanvasElement, p) => {
      const box = node.getBoundingClientRect();
      const px = Math.max(0, Math.min(node.width - 1, Math.floor((p.x + p.dx / box.width) * node.width)));
      const py = Math.max(0, Math.min(node.height - 1, Math.floor((p.y + p.dy / box.height) * node.height)));
      return node.getContext('2d')!.getImageData(px, py, 1, 1).data[3];
    }, { x, y, dx, dy });
  }
  await scratchLine(page, [.2, .25], [.2, .25], 1);
  expect(await alpha(.2, .25)).toBe(0);
  expect(await alpha(.2, .25, 15)).toBe(0);
  expect(await alpha(.2, .25, 0, 15)).toBe(0);
  expect(await alpha(.2, .25, 22)).toBe(255);
  expect(await alpha(.2, .25, 0, 22)).toBe(255);
  const scratched = await dimensions();
  const labelCount = await page.evaluate(() => window.__pr6ScratchLabels.length);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await dimensions()).width).toBe(scratched.width);
  expect((await dimensions()).height).toBe(scratched.height);
  expect(await alpha(.2, .25)).toBe(0);
  expect(await page.evaluate(() => window.__pr6ScratchLabels.length)).toBe(labelCount);
  await scratchLine(page, [.8, .75], [.8, .75], 1);
  expect(await alpha(.8, .75)).toBe(0);
  expect(await alpha(.8, .75, 15)).toBe(0);
  expect(await alpha(.8, .75, 0, 15)).toBe(0);
  expect(await alpha(.8, .75, 22)).toBe(255);
  expect(await alpha(.8, .75, 0, 22)).toBe(255);
});
