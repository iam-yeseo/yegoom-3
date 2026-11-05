import { mkdir, readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BootstrapResponse, Player } from '../../shared/types';

const MORNING = '2026-10-30T00:00:00Z';
const EVENING = '2026-10-30T09:00:00Z';
const ORIGIN = 'http://localhost:8788';
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(MORNING));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.25' });
});

async function navigate(page: Page, path: string) {
  await page.evaluate(value => { location.hash = value; }, path);
}
async function signedInSnapshot(page: Page): Promise<BootstrapResponse> {
  const response = await page.request.post('/api/auth/login', {
    // page.setExtraHTTPHeaders applies to the browser page; APIRequestContext
    // must identify its own fixture IP to avoid another suite's login bucket.
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.25' },
    data: { username: 'yeseo', password: 'e2e-only-password-2026' },
  });
  expect(response.status(), 'isolated fixture login').toBe(200);
  const bootstrap = await page.request.get('/api/bootstrap');
  expect(bootstrap.ok()).toBe(true);
  return bootstrap.json();
}
async function capture(page: Page, name: string, info: TestInfo) {
  await mkdir('docs/screenshots', { recursive: true });
  for (const width of [390, 560]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.locator('img').evaluateAll(images => images
      .filter(image => image.getBoundingClientRect().height > 0)
      .every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {}))));
    if (await page.locator('.ranking-preview').count()) await page.locator('.ranking-preview').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.evaluate(() => {
      scrollTo(0, 0);
      return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const path = `docs/screenshots/update-pr3-${name}-${width}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await info.attach(`${name}-${width}`, { path, contentType: 'image/png' });
  }
}

type Person = readonly [username: string, displayName: string, weeklyScore: number];
function withPlayers(snapshot: BootstrapResponse, people: readonly Person[]): BootstrapResponse {
  const players = people.map(([username, displayName, weeklyScore]): Player => ({
    id: snapshot.players.find(player => player.username === username)?.id ?? `fixture-${username}`,
    username, displayName, weeklyScore,
    character: snapshot.players.find(player => player.username === username)?.character ?? 'cat', photoVersion: null, tag: null,
  }));
  const me = players.find(player => player.username === snapshot.user.username)!;
  return { ...snapshot, notifications: { unread: 0, recent: [] }, players, dailyScores: [me.weeklyScore, 0, 0, 0, 0, 0, 0],
    user: { ...snapshot.user, displayName: me.displayName, weeklyScore: me.weeklyScore, photoVersion: null } };
}

test('home rank sentences cover every tie case and share competition ranks with ranking labels', async ({ page }, info) => {
  test.setTimeout(60000);
  const snapshot = await signedInSnapshot(page);
  const cases: { name: string; people: Person[]; line: string; chip: string | null }[] = [
    { name: 'sole first, one runner-up', people: [['yeseo', '예서', 30], ['siwon', '시원', 18]], line: '2위 시원님과 12점 차', chip: '주간 1위' },
    { name: 'sole first, tied runners-up', people: [['yeseo', '예서', 30], ['siwon', '시원', 18], ['min', '민', 18]], line: '2위 시원님 외 1명과 12점 차', chip: '주간 1위' },
    { name: 'only player', people: [['yeseo', '예서', 30]], line: '이번 주 1위', chip: '주간 1위' },
    { name: 'two joint leaders', people: [['yeseo', '예서', 30], ['siwon', '시원', 30], ['min', '민', 10]], line: '시원님과 공동 1등', chip: '주간 공동 1위' },
    { name: 'three joint leaders', people: [['yeseo', '예서', 30], ['siwon', '시원', 30], ['min', '민', 30]], line: '시원님, 민님과 공동 1등', chip: '주간 공동 1위' },
    { name: 'four joint leaders', people: [['yeseo', '예서', 30], ['siwon', '시원', 30], ['min', '민', 30], ['jun', '준', 30]], line: '시원님 외 2명과 공동 1등', chip: '주간 공동 1위' },
    { name: 'all zero', people: [['yeseo', '예서', 0], ['siwon', '시원', 0], ['min', '민', 0]], line: '아직 이번 주 점수가 없어요', chip: null },
    { name: 'sole second', people: [['yeseo', '예서', 22], ['min', '민', 30], ['siwon', '시원', 10]], line: '1위 민님까지 8점', chip: '주간 2위' },
    { name: 'joint second', people: [['yeseo', '예서', 22], ['siwon', '시원', 22], ['min', '민', 30]], line: '시원님과 공동 2등 · 1위 민님까지 8점', chip: '주간 공동 2위' },
    { name: 'below joint leaders', people: [['yeseo', '예서', 22], ['min', '민', 30], ['siwon', '시원', 30]], line: '1위 민님 외 1명까지 8점', chip: '주간 3위' },
  ];
  let payload = snapshot;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: payload }));
  // The ranking screen reads its own period response (PR 8); mirror the same fixture.
  await page.route('**/api/ranking?**', route => route.fulfill({ json: {
    period: 'week', range: { start: '2026-10-26', end: '2026-11-01' },
    standings: payload.players.map(player => ({ userId: player.id, username: player.username, displayName: player.displayName,
      photoVersion: player.photoVersion, character: player.character, score: player.weeklyScore }))
      .sort((a, b) => b.score - a.score), // stable: same tie order as the mocked bootstrap
    buckets: ['월', '화', '수', '목', '금', '토', '일'].map((label, index) => ({ key: String(index), label, score: index === 4 ? payload.user.weeklyScore : 0, current: index === 4, future: index > 4 })),
    history: [], nextBefore: null, serverTime: MORNING,
  } }));
  for (const scenario of cases) {
    await test.step(scenario.name, async () => {
      payload = withPlayers(snapshot, scenario.people);
      await page.goto('/');
      await expect(page.locator('.room-name')).toHaveText('예서님');
      await expect(page.locator('.home h1')).toHaveText('이번 주 점수');
      await expect(page.locator('.home h1')).toHaveCount(1);
      await expect(page.locator('.rank-line')).toHaveText(scenario.line);
      if (scenario.chip) await expect(page.locator('.rank-chip')).toHaveText(scenario.chip);
      else await expect(page.locator('.rank-chip')).toHaveCount(0);
      const sorted = [...scenario.people].sort((a, b) => b[2] - a[2]);
      await expect(page.locator('.ranking-preview-main strong')).toHaveText(sorted.map(person => person[1]));
      if (scenario.name === 'two joint leaders') {
        await expect(page.locator('.ranking-preview .rank-dot')).toHaveText(['1', '1', '3']);
        await capture(page, 'joint-first', info);
        await page.locator('.rank-line').click();
        await expect(page).toHaveURL(/#\/ranking$/);
        await expect(page.locator('.podium-name')).toHaveText(['시원', '예서', '민']);
        await expect(page.locator('.podium-rank')).toHaveText(['1', '1', '3']);
        await expect(page.locator('.daily-card .card-head span')).toHaveText('예서');
        await capture(page, 'ranking', info);
      }
    });
  }
});

test('home identity uses the current profile photo and truncates a long nickname before the gold balance', async ({ page }) => {
  const snapshot = await signedInSnapshot(page);
  const photo = `data:image/webp;base64,${(await readFile('tests/fixtures/photo-square.webp')).toString('base64')}`;
  const uploaded = await page.request.put('/api/me/photo', { headers: { Origin: ORIGIN },
    data: { photo, expectedUserId: snapshot.user.id } });
  expect(uploaded.ok()).toBe(true);
  try {
    const latest = await (await page.request.get('/api/bootstrap')).json() as BootstrapResponse;
    const longName = '가나다라마바사아자차';
    const payload = { ...latest, user: { ...latest.user, displayName: longName, gold: 123456789 },
      players: latest.players.map(player => player.id === latest.user.id ? { ...player, displayName: longName } : player) };
    await page.route('**/api/bootstrap', route => route.fulfill({ json: payload }));
    for (const now of [MORNING, EVENING]) {
      await page.clock.setFixedTime(new Date(now));
      await page.goto('/');
      const avatar = page.locator('.room-identity img.avatar-photo');
      await expect(avatar).toHaveAttribute('src', `/api/users/${latest.user.id}/photo?v=${latest.user.photoVersion}`);
      await expect(avatar).toHaveAttribute('alt', `${longName}님 프로필 사진`);
      for (const width of [390, 560]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.locator('.room-top').evaluate(top => {
          const identity = top.querySelector('.room-identity')!.getBoundingClientRect();
          const name = top.querySelector('.room-name')!;
          const gold = top.querySelector('.gold')!.getBoundingClientRect();
          const bell = top.querySelector('.room-bell')!.getBoundingClientRect();
          const avatar = top.querySelector('.avatar')!.getBoundingClientRect();
          const style = getComputedStyle(name);
          // The balance now sits under the nickname; the bell keeps the corner.
          return { separated: identity.right <= bell.left, goldInside: gold.right <= identity.right + 1,
            avatarWidth: avatar.width,
            overflow: style.overflow, ellipsis: style.textOverflow, noWrap: style.whiteSpace,
            documentOverflow: document.documentElement.scrollWidth > innerWidth };
        });
        expect(layout.separated).toBe(true);
        expect(layout.goldInside).toBe(true);
        expect(layout.avatarWidth).toBeGreaterThanOrEqual(28);
        expect(layout.avatarWidth).toBeLessThanOrEqual(32);
        expect(layout).toMatchObject({ overflow: 'hidden', ellipsis: 'ellipsis', noWrap: 'nowrap', documentOverflow: false });
      }
    }
  } finally {
    const removed = await page.request.delete('/api/me/photo', { headers: { Origin: ORIGIN }, data: { expectedUserId: snapshot.user.id } });
    expect(removed.ok()).toBe(true);
  }
});

test('morning and evening previews retain honorific sentences, plain ranking labels and intact card times without APIs', async ({ page }, info) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => { requests.push(route.request().url()); return route.abort(); });
  for (const [name, now] of [['morning-home', MORNING], ['evening-home', EVENING]]) {
    await page.clock.setFixedTime(new Date(now));
    await page.goto('/#/preview');
    await expect(page.locator('.room-name')).toHaveText('yeseo님');
    await expect(page.locator('.home h1')).toHaveText('이번 주 점수');
    await expect(page.locator('.rank-line')).toContainText('siwon님');
    await expect(page.locator('.ranking-preview-main strong')).toHaveText(['siwon', 'yeseo', 'min']);
    await expect(page.locator('.room-identity .avatar')).toHaveCount(1);
    await expect(page.locator('.room-identity .character')).toHaveCount(1);
    for (const width of [390, 560]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const times = await page.locator('.home-schedule').evaluateAll(elements => elements.map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const lines = new Set(Array.from(range.getClientRects()).filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
        const box = element.getBoundingClientRect();
        const card = element.closest('.card')!.getBoundingClientRect();
        return { text: element.textContent, lines: lines.size, contained: box.left >= card.left && box.right <= card.right };
      }));
      expect(times.some(time => time.text?.includes('17시 30분 추첨'))).toBe(true);
      for (const time of times) expect(time).toMatchObject({ lines: 1, contained: true });
    }
    await capture(page, name, info);
    await navigate(page, '/preview/ranking');
    await expect(page.locator('.podium-name')).toHaveText(['yeseo', 'siwon', 'min']);
    await expect(page.locator('.daily-card .card-head span')).toHaveText('yeseo');
    await expect(page.locator('.last-week .list-row strong')).toHaveText(['siwon', 'yeseo', 'min']);
  }
  expect(requests).toEqual([]);
});
