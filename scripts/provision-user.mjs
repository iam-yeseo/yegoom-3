#!/usr/bin/env node
import { webcrypto, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
if (args.includes('--help')) {
  console.log('Usage: npm run user:create -- --username min --display-name 민 [--role player|admin] [--local|--remote]');
  console.log('Password is prompted privately, or read from YEGOOM_PASSWORD. Min. 12 characters.');
  console.log('Reusing a username resets its password and revokes all its sessions.');
  console.log('Deactivate: npm run user:create -- --username min --deactivate [--local|--remote]');
  process.exit(0);
}
const username = argument('--username', '');
const displayName = argument('--display-name', username);
const role = argument('--role', 'player');
const target = args.includes('--remote') ? '--remote' : '--local';
if (args.includes('--local') && args.includes('--remote')) throw new Error('Choose --local or --remote, not both.');
if (!/^[a-z0-9_-]{2,32}$/.test(username)) throw new Error('Username must contain 2–32 lowercase letters, digits, underscores or hyphens.');
if (!displayName || displayName.length > 40) throw new Error('Display name must contain 1–40 characters.');
if (!['player', 'admin'].includes(role)) throw new Error('Role must be player or admin.');
if (['min', 'siwon', 'yeseo'].includes(username) && role !== 'player') throw new Error('The three game author accounts must retain the player role.');
const quote = value => `'${value.replaceAll("'", "''")}'`;
function readPassword() {
  if (process.env.YEGOOM_PASSWORD) return Promise.resolve(process.env.YEGOOM_PASSWORD);
  if (!process.stdin.isTTY) throw new Error('Interactive terminal required. For automation set YEGOOM_PASSWORD.');
  process.stdout.write('New password (12–128 characters, hidden): ');
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const restore = () => {
      process.stdin.off('data', receive);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const receive = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { restore(); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { restore(); resolvePassword(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', receive);
  });
}
let sql;
if (args.includes('--deactivate')) {
  sql = `UPDATE users SET active = 0 WHERE username = ${quote(username)};\nDELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ${quote(username)});`;
} else {
  const password = await readPassword();
  if (password.length < 12 || password.length > 128) throw new Error('Password must contain 12–128 characters.');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  const encoded = `pbkdf2-sha256$100000$${Buffer.from(salt).toString('hex')}$${Buffer.from(derived).toString('hex')}`;
  sql = `INSERT INTO users (id, username, display_name, password_hash, role) VALUES (${quote(randomUUID())}, ${quote(username)}, ${quote(displayName)}, ${quote(encoded)}, ${quote(role)})
ON CONFLICT(username) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash, role = excluded.role, active = 1;
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ${quote(username)});`;
}
const directory = await mkdtemp(join(tmpdir(), 'yegoom-provision-'));
try {
  const path = join(directory, 'user.sql');
  await writeFile(path, sql, { mode: 0o600 });
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
  // Do not pass plaintext credentials to Wrangler or print SQL/password hashes.
  const subprocessEnv = { ...process.env };
  delete subprocessEnv.YEGOOM_PASSWORD;
  const result = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', target, '--file', path, '--yes'], { cwd: root, env: subprocessEnv, stdio: 'pipe', encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    // Wrangler errors may echo the SQL file; keep credentials out of terminal output.
    throw new Error(`Provisioning failed (${result.status ?? 'spawn error'}). Check D1 migrations and Cloudflare credentials with Wrangler, then retry.`);
  }
  console.log(`${args.includes('--deactivate') ? 'Deactivated' : 'Provisioned'} ${username} (${target.slice(2)}). Existing sessions revoked.`);
} finally { await rm(directory, { recursive: true, force: true }); }
