import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Curling, the penalty shoot-out and bingo in the serverless preview: each is
// opened from the home screen and played with real pointer input.
test.use({ serviceWorkers: 'block' });

/** Drags from a point on the 360x560 stage, fast enough to count as a swipe. */
async function swipe(page: Page, from: [number, number], by: [number, number], ms = 90) {
  const box = (await page.locator('.arcade-stage canvas').boundingBox())!;
  const at = (x: number, y: number) => [box.x + x / 360 * box.width, box.y + y / 560 * box.height] as const;
  const [x, y] = at(...from);
  await page.mouse.move(x, y); await page.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(x + by[0] * step / 8 * box.width / 360, y + by[1] * step / 8 * box.height / 560);
    await page.waitForTimeout(ms / 8);
  }
  await page.mouse.up();
}
async function open(page: Page) {
  await page.route('**/api/**', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/preview');
  await mkdir('docs/screenshots', { recursive: true });
}

test('curling: the home tile opens the sheet, a direction is chosen and a swipe slides the stone', async ({ page }) => {
  await open(page);
  const tile = page.locator('.solo-tile', { hasText: '컬링' });
  await expect(tile).toContainText('이번 세트 도전 가능');
  await tile.click();
  await expect(page).toHaveURL(/#\/preview\/play\/curling$/);
  await expect(page.getByRole('button', { name: '엔드 시작하기' })).toBeVisible();
  await page.getByRole('button', { name: '연습하기' }).click();
  const shell = page.getByRole('region', { name: '컬링 연습' });
  await expect(shell).toBeVisible();
  // The stage keeps its shape and the controls stay on screen.
  const stage = (await page.locator('.arcade-stage canvas').boundingBox())!;
  expect(stage.width / stage.height).toBeCloseTo(360 / 560, 2);
  expect(stage.y + stage.height).toBeLessThanOrEqual(844);
  // Tapping the ice turns the aim; the arrows nudge it.
  await expect(shell.locator('.arcade-aim b')).toHaveText('가운데');
  await page.mouse.click(stage.x + stage.width * 0.7, stage.y + stage.height * 0.3);
  await expect(shell.locator('.arcade-aim b')).toContainText('오른쪽');
  const aimed = await shell.locator('.arcade-aim b').innerText();
  await shell.getByRole('button', { name: '방향을 왼쪽으로' }).click();
  await expect(shell.locator('.arcade-aim b')).not.toHaveText(aimed);
  await swipe(page, [180, 492], [0, -170]);
  await expect(shell.locator('.arcade-stage')).toHaveAttribute('data-mode', 'sliding');
  // Once it stops the result is named and the next stone is ready.
  await expect(shell.locator('.arcade-callout strong')).toBeVisible({ timeout: 12000 });
  await expect(shell.locator('.arcade-practice-stats')).toContainText('2/5');
  await expect(shell.locator('.arcade-meter b')).not.toHaveText('—');
  await page.screenshot({ path: 'docs/screenshots/curling-play-390.png' });
  await shell.getByRole('button', { name: '나가기' }).click();
  await expect(shell).toBeHidden();
});

test('curling: an official end is recorded after the fifth stone and uses this slot\'s chance', async ({ page }) => {
  await open(page);
  await page.goto('/#/preview/play/curling');
  await page.getByRole('button', { name: '엔드 시작하기' }).click();
  const shell = page.getByRole('region', { name: '컬링 공식 도전' });
  await expect(shell.locator('.play-progress')).toContainText('0/5');
  for (let stone = 1; stone <= 5; stone++) {
    await expect(shell.locator('.arcade-stage')).toHaveAttribute('data-mode', 'ready', { timeout: 12000 });
    await swipe(page, [180, 492], [0, -170]);
    await expect(shell.locator('.play-progress')).toContainText(`${stone}/5`, { timeout: 12000 });
  }
  const result = page.locator('.play-result-dialog');
  await expect(result).toBeVisible();
  await expect(result.locator('.play-result-status')).toHaveText('기록했어요');
  await result.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.arcade-official')).toContainText('성공!');
  await expect(page.getByRole('button', { name: '엔드 시작하기' })).toHaveCount(0);
  await expect(page.locator('.arcade-official')).toContainText('다음 세트');
});

test('penalty: the whistle starts the clock, a swipe kicks, and the result is explained', async ({ page }) => {
  await open(page);
  await page.locator('.solo-tile', { hasText: '승부차기' }).click();
  await expect(page).toHaveURL(/#\/preview\/play\/penalty$/);
  await page.getByRole('button', { name: '연습하기' }).click();
  const shell = page.getByRole('region', { name: '승부차기 연습' });
  await expect(shell.locator('.arcade-stage')).toHaveAttribute('data-mode', 'aiming', { timeout: 4000 });
  await swipe(page, [180, 462], [70, -180], 70);
  await expect(shell.locator('.arcade-stage')).toHaveAttribute('data-mode', 'after', { timeout: 4000 });
  await expect(shell.locator('.arcade-callout strong')).toBeVisible();
  await expect(shell.locator('.arcade-practice-stats')).toContainText('/1');
  await expect(shell.locator('.arcade-aim b')).toContainText('오른쪽');
  await page.screenshot({ path: 'docs/screenshots/penalty-play-390.png' });
  // The next keeper walks in by themselves.
  await expect(shell.locator('.arcade-practice-stats')).toContainText('골키퍼 2번', { timeout: 6000 });
});

test('bingo: the leader names a topic, fills a board, and confirms a word on their turn', async ({ page }) => {
  await open(page);
  const row = page.locator('.game-row', { hasText: '빙고' });
  await expect(row).toContainText('주제를 정해 첫 판을 열어 보세요');
  await row.click();
  await expect(page).toHaveURL(/#\/preview\/play\/bingo$/);
  const create = page.getByRole('button', { name: /AI로 단어 30개 만들기/ });
  await expect(create).toBeDisabled();
  await page.getByPlaceholder(/분식집/).fill('분식집 메뉴');
  await page.getByRole('tab', { name: '5줄' }).click();
  await create.click();
  // Filling: 30 words, 25 cells. The board cannot be handed in until it is full.
  await expect(page.locator('.bingo-chip').first()).toHaveText('5줄 빙고');
  await expect(page.locator('.bingo-pool .bingo-word')).toHaveCount(30);
  const submit = page.getByRole('button', { name: '이 판으로 내기' });
  await expect(submit).toBeDisabled();
  await page.locator('.bingo-pool .bingo-word').first().click();
  await expect(page.locator('.bingo-count')).toHaveText('1/25');
  await page.getByRole('button', { name: '자동으로 채우기' }).click();
  await expect(page.locator('.bingo-count')).toHaveText('25/25');
  await submit.click();
  // Everyone is in: play starts with the leader's turn.
  await expect(page.getByText('내 차례예요!')).toBeVisible({ timeout: 5000 });
  const confirm = page.getByRole('button', { name: /지울 단어를 골라 주세요|지우기 확정/ });
  await expect(confirm).toBeDisabled();
  const cell = page.locator('.bingo-board button.bingo-cell:not([disabled])').first();
  const word = await cell.innerText();
  await cell.click();
  await expect(confirm).toHaveText(`「${word}」 지우기 확정`);
  await confirm.click();
  await expect(page.locator('.bingo-board .bingo-cell.is-called', { hasText: word })).toBeVisible();
  await expect(page.locator('.bingo-pool.is-called')).toContainText(word);
  // The friends take their turns and it comes back round.
  await expect(page.getByText('내 차례예요!')).toBeVisible({ timeout: 8000 });
  expect(await page.locator('.bingo-pool.is-called .bingo-word').count()).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: 'docs/screenshots/bingo-play-390.png', fullPage: true });
});

test('signed in: curling is recorded by the server, and bingo opens with the leader\'s own words when there is no AI', async ({ page }) => {
  const headers = { Origin: 'http://localhost:8788', 'CF-Connecting-IP': '192.0.2.91' };
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '192.0.2.91' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await page.request.post('/api/auth/login', { headers, data: { username: 'yeseo', password: 'e2e-only-password-2026' } })).status()).toBe(200);
  const boot = await (await page.request.get('/api/bootstrap')).json();
  expect(boot.arcade).toMatchObject({ curling: { available: true, isAdmin: false }, penalty: { available: true } });
  expect(boot.bingo).toMatchObject({ status: 'idle', joined: false });

  // Curling through the API: five stones, simulated again by the Worker.
  const started = await (await page.request.post('/api/arcade/curling/sets', { headers, data: { requestId: 'e2e-curling-0123456789abcdef' } })).json();
  expect(started.current).toMatchObject({ completed: false, tries: [] });
  const inputs = [{ power: 55, aim: 0 }, { power: 52, aim: -45 }, { power: 100, aim: 60 }, { power: 20, aim: 0 }, { power: 52, aim: 45 }];
  const finished = await page.request.post('/api/arcade/curling/finish', { headers, data: { setId: started.current.id, inputs } });
  expect(finished.status()).toBe(200);
  const recorded = await finished.json();
  // The third goes through the back and the fourth stops short of the hog line; three stay in the house.
  expect(recorded.set).toMatchObject({ made: 3, completed: true, points: 3, gold: 30 });
  expect(recorded.set.tries.map((entry: { kind: string }) => entry.kind)).toEqual(['button', 'house', 'long', 'short', 'house']);
  expect((await page.request.post('/api/arcade/nothing/sets', { headers, data: {} })).status()).toBe(404);
  await page.goto('/#/');
  await expect(page.locator('.solo-tile', { hasText: '컬링' })).toContainText('이번 세트 3개');
  await page.locator('.solo-tile', { hasText: '컬링' }).click();
  await expect(page.locator('.arcade-official')).toContainText('3개 성공!');
  await expect(page.locator('.arcade-today')).toContainText('3개');

  // Bingo: no OpenAI key on the test server, so the AI path answers 503 and the leader types the words.
  await page.goto('/#/play/bingo');
  await page.getByPlaceholder(/분식집/).fill('과일');
  await page.getByRole('button', { name: /AI로 단어 30개 만들기/ }).click();
  await expect(page.locator('.bingo-error')).toContainText('직접 적어서');
  const words = Array.from({ length: 30 }, (_, i) => `과일${i + 1}`);
  await page.locator('.bingo-field textarea').fill(words.join('\n'));
  await expect(page.getByText('단어 직접 적기 (30/30)')).toBeVisible();
  await page.getByRole('button', { name: '이 단어로 빙고 열기' }).click();
  await expect(page.locator('.bingo-pool .bingo-word')).toHaveCount(30);
  await page.getByRole('button', { name: '자동으로 채우기' }).click();
  await page.getByRole('button', { name: '이 판으로 내기' }).click();
  await expect(page.getByRole('button', { name: /판을 냈어요/ })).toBeVisible();
  const state = await (await page.request.get('/api/bingo')).json();
  expect(state.bingo.game).toMatchObject({ topic: '과일', source: 'manual', status: 'filling', lines: 3 });
  expect(state.bingo.game.seats).toHaveLength(1);
  expect((await (await page.request.get(`/api/bingo?since=${state.version}`)).json()).unchanged).toBe(true);
  await page.goto('/#/');
  await expect(page.locator('.game-row', { hasText: '빙고' })).toContainText('판 제출 완료');
  // The leader calls it off so later specs find an empty table.
  await page.goto('/#/play/bingo');
  await page.getByRole('button', { name: '이번 판 취소하기' }).click();
  await expect(page.getByText('다음 빙고를 기다리는 중')).toBeVisible();
});
