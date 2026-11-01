import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const wrangler = 'node_modules/wrangler/bin/wrangler.js';
const env = { ...process.env, CI: 'true' };
mkdirSync('.test-build', { recursive: true });
// Every run gets a fresh local database. Keep the append-only ledger triggers
// intact instead of deleting accounting rows between browser test runs.
const state = mkdtempSync('.test-build/e2e-');
const cleanup = () => rmSync(state, { recursive: true, force: true });
const configPath = '.test-build/e2e.wrangler.json';
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
config.main = './e2e-worker.js';
config.assets.directory = '../dist';
for (const database of config.d1_databases) database.migrations_dir = '../migrations';
writeFileSync(configPath, JSON.stringify(config));

// Freeze time only in the compiled test artifact, just like integration tests.
// This still runs real login, Worker and D1 code. Production has no clock hook,
// header, environment override or test seed endpoint.
const timestamp = Date.parse('2026-10-30T00:00:00Z'); // 09:00 KST, before all deadlines.
const artifact = await build({
  entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false,
  define: { Date: 'TestDate' },
  banner: { js: `class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [${timestamp}])); } static now() { return ${timestamp}; } }` },
});
writeFileSync('.test-build/e2e-worker.js', artifact.outputFiles[0].text.replaceAll("unixepoch('now') * 1000", String(timestamp)));
const run = (args) => {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--config', configPath], { env, stdio: 'inherit' });
  if (result.status !== 0) { cleanup(); process.exit(result.status || 1); }
};
run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
// This fixed password exists exclusively in an isolated local browser-test database.
const salt = randomBytes(16);
const passwordHash = `pbkdf2-sha256$100000$${salt.toString('hex')}$${pbkdf2Sync('e2e-only-password-2026', salt, 100000, 32, 'sha256').toString('hex')}`;
const statements = ['min', 'siwon', 'yeseo', 'admin'].map(username =>
  `INSERT INTO users (id, username, display_name, password_hash, role) VALUES ('e2e-${username}', '${username}', '${username}', '${passwordHash}', '${username === 'admin' ? 'admin' : 'player'}');`);
// A six-day streak earns the seventh-day reward today. A September record
// verifies that changing calendar months loads server history rather than the
// current month's bootstrap days. Legacy browser attendance is never seeded.
for (const [date, streak] of [
  ['2026-09-29', 1], ['2026-10-24', 1], ['2026-10-25', 2],
  ['2026-10-26', 3], ['2026-10-27', 4], ['2026-10-28', 5], ['2026-10-29', 6],
]) {
  const createdAt = `${date}T00:00:00.000Z`;
  statements.push(`INSERT INTO attendance (user_id, date, streak, created_at) VALUES ('e2e-min', '${date}', ${streak}, '${createdAt}');`);
  statements.push(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-attendance-${date}', 'e2e-min', 'gold', 100, '출석 보상', 'attendance:${date}:e2e-min', '${createdAt}');`);
}
// Test-only spending money and coupons; production has no automatic grants.
for (const username of ['min', 'siwon', 'yeseo']) {
  statements.push(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-gold-${username}', 'e2e-${username}', 'gold', 10000, '브라우저 테스트 시작 골드', 'fixture:gold:${username}', '2026-10-23T00:00:00.000Z');`);
  for (const item of ['lotto_ticket', 'speetto_ticket']) {
    statements.push(`INSERT INTO inventory_ledger (id, user_id, item, amount, reason, reference, created_at) VALUES ('fixture-${item}-${username}', 'e2e-${username}', '${item}', 2, '브라우저 테스트 이용권', 'fixture:${item}:${username}', '2026-10-23T00:00:00.000Z');`);
  }
}
// Real, untouched physics boards provide repeatable single/multiple catches.
// Only this isolated fixture selects the board and the tenth (strong) attempt;
// production has no seed endpoint, forced outcome, or browser-only physics.
const physicsArtifact = await build({
  entryPoints: ['shared/claw-physics.ts'], bundle: true, format: 'esm', platform: 'node', write: false,
});
const { createBoard } = await import(`data:text/javascript;base64,${Buffer.from(physicsArtifact.outputFiles[0].text).toString('base64')}`);
for (const [username, generation, seed] of [
  ['min', 1, 1792405194], ['siwon', 7, 681247775], ['yeseo', 1, 1792405194],
]) {
  const board = JSON.stringify(createBoard(generation, seed));
  statements.push(`INSERT INTO claw_accounts (user_id, free_coins, purchased_coins, last_grant_slot, board_json, generation, version, next_play_at, power_counter) VALUES ('e2e-${username}', 5, 0, ${Math.floor(timestamp / 10800000)}, '${board}', ${generation}, 0, 0, 9);`);
}
// A complete, valid board makes browser reward assertions and screenshots
// deterministic. Production board creation still uses crypto randomness.
const kujiFixtureGrades = ['A', 'E', ...[
  ['B', 2], ['C', 3], ['D', 6], ['E', 9], ['F', 15], ['G', 25], ['H', 38],
].flatMap(([grade, count]) => Array(count).fill(grade))];
statements.push(`INSERT INTO kuji_boards (id, grades, created_at) VALUES (1, '${JSON.stringify(kujiFixtureGrades)}', '2026-10-30T00:00:00.000Z');`);
// An overdue winning lotto ticket exercises real settlement and historical
// results. The owned speetto fixture was already paid when it was purchased.
const lottoFixture = '00000000-0000-4000-8000-000000000002';
const speettoFixture = '00000000-0000-4000-8000-000000000001';
const fixtureNumbers = [1, 2, 3, 4, 5];
statements.push(`INSERT INTO lotto_draws (date, numbers, created_at) VALUES ('2026-10-29', '${JSON.stringify(fixtureNumbers)}', '2026-10-29T08:00:00.000Z');`);
statements.push(`INSERT INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome) VALUES ('${lottoFixture}', 'e2e-yeseo', 'fixture-lotto-yeseo', 'lotto', '${JSON.stringify({ numbers: fixtureNumbers, payment: 'gold' })}', 'gold', 500, '2026-10-29', '2026-10-29T00:00:00.000Z', '${JSON.stringify({ drawDate: '2026-10-29', numbers: fixtureNumbers })}');`);
statements.push(`INSERT INTO lotto_tickets (id, draw_date, numbers) VALUES ('${lottoFixture}', '2026-10-29', '${JSON.stringify(fixtureNumbers)}');`);
statements.push(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-lotto-cost', 'e2e-yeseo', 'gold', -500, '데일리 로또 구매', 'buy:lotto:e2e-yeseo:fixture-lotto-yeseo', '2026-10-29T00:00:00.000Z');`);
statements.push(`INSERT INTO shop_purchases (id, user_id, request_id, kind, request_payload, payment, cost, date, created_at, outcome) VALUES ('${speettoFixture}', 'e2e-siwon', 'fixture-speetto-siwon', 'speetto', '${JSON.stringify({ payment: 'gold' })}', 'gold', 300, '2026-10-29', '2026-10-29T00:00:00.000Z', '${JSON.stringify({ cells: ['cat', 'cat', 'cat'], won: true, prize: 1500 })}');`);
statements.push(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-speetto-cost', 'e2e-siwon', 'gold', -300, '스피또 구매', 'buy:speetto:e2e-siwon:fixture-speetto-siwon', '2026-10-29T00:00:00.000Z');`);
statements.push(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-speetto-prize', 'e2e-siwon', 'gold', 1500, '스피또 당첨', 'speetto:prize:${speettoFixture}', '2026-10-29T00:00:00.000Z');`);
// Four published days plus an empty day exercise the recent-three-round UI.
// The rows are intentionally unsettled so the real read path generates payouts.
for (const [game, author, answer, secondGuess] of [
  ['wake', 'min', '08:37:42', '08:38:42'],
  ['offwork', 'siwon', '18:37:42', '18:38:42'],
  ['luck', 'yeseo', '77', '84'],
]) {
  for (const date of ['2026-10-29', '2026-10-27', '2026-10-24', '2026-10-23']) {
    const revealedAt = Date.parse(`${date}T19:00:00+09:00`);
    statements.push(`INSERT INTO game_rounds (game_id, round_date, answer, revealed_at, updated_at) VALUES ('${game}', '${date}', '${answer}', ${revealedAt}, ${revealedAt});`);
    const players = ['min', 'siwon', 'yeseo'].filter(name => name !== author);
    players.forEach((username, index) => {
      statements.push(`INSERT INTO predictions (game_id, round_date, player_id, value, updated_at) VALUES ('${game}', '${date}', 'e2e-${username}', '${index ? secondGuess : answer}', ${revealedAt - 3600000});`);
      statements.push(`INSERT INTO ledger (id, user_id, currency, amount, reason, reference, created_at) VALUES ('fixture-${game}-${date}-${username}', 'e2e-${username}', 'gold', 100, '예측 참여', 'predict:${game}:${date}:e2e-${username}', '${new Date(revealedAt - 3600000).toISOString()}');`);
    });
  }
  statements.push(`INSERT INTO game_rounds (game_id, round_date, updated_at) VALUES ('${game}', '2026-10-28', ${timestamp});`);
}
writeFileSync('.test-build/browser-users.sql', statements.join('\n'), { mode: 0o600 });
try { run(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', '.test-build/browser-users.sql', '--yes']); }
finally { unlinkSync('.test-build/browser-users.sql'); }
const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--port', '8788', '--persist-to', state, '--config', configPath], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { cleanup(); process.exit(code ?? 0); });
