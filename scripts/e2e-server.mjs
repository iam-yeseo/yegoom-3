import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
const state = '.test-build/e2e';
const env = { ...process.env, CI: 'true' };
const run = (args) => {
  const result = spawnSync(process.execPath, [wrangler, ...args], { env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
};
mkdirSync('.test-build', { recursive: true });
run(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
// This fixed password exists exclusively in an isolated local browser-test database.
const salt = randomBytes(16);
const passwordHash = `pbkdf2-sha256$100000$${salt.toString('hex')}$${pbkdf2Sync('e2e-only-password-2026', salt, 100000, 32, 'sha256').toString('hex')}`;
const sql = `DELETE FROM predictions; DELETE FROM game_rounds; DELETE FROM sessions; DELETE FROM login_attempts;
${['min','siwon','yeseo','admin'].map(username => `INSERT INTO users (id, username, display_name, password_hash, role) VALUES ('e2e-${username}', '${username}', '${username}', '${passwordHash}', '${username === 'admin' ? 'admin' : 'player'}') ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, active=1;`).join('\n')}`;
writeFileSync('.test-build/browser-users.sql', sql, { mode: 0o600 });
try { run(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--file', '.test-build/browser-users.sql', '--yes']); }
finally { unlinkSync('.test-build/browser-users.sql'); }
const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--port', '8788', '--persist-to', state], { env, stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
