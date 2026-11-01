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
