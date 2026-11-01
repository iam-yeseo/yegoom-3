#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function query(sql) {
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'yegoom-db', '--remote', '--command', sql, '--json'], {
    cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  // Wrangler output can include credential diagnostics. Keep it out of logs;
  // only validated query rows are used, and this script never executes a write.
  if (result.error || result.status !== 0) throw new Error('WRANGLER_FAILED');
  let output;
  try { output = JSON.parse(result.stdout); } catch { throw new Error('INVALID_RESPONSE'); }
  if (!Array.isArray(output) || output.length !== 1 || output[0]?.success !== true || !Array.isArray(output[0]?.results)) {
    throw new Error('INVALID_RESPONSE');
  }
  return output[0].results;
}
function identifiers(ids) {
  return ids.slice(0, 10).map(id => JSON.stringify(id)).join(', ') + (ids.length > 10 ? ', …' : '');
}

try {
  const tables = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users';");
  if (tables.length > 1 || (tables.length === 1 && tables[0]?.name !== 'users')) throw new Error('INVALID_RESPONSE');
  if (tables.length === 0) {
    console.log('users 테이블이 없는 새 DB입니다. 닉네임 사전 검사를 통과했습니다.');
  } else {
    const rows = query('SELECT id, display_name FROM users WHERE active = 1 ORDER BY id;');
    const ids = new Set(); const names = new Map(); const noncanonical = [];
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.display_name !== 'string') {
        throw new Error('INVALID_RESPONSE');
      }
      ids.add(row.id);
      const normalized = row.display_name.normalize('NFC').trim();
      if (row.display_name !== normalized) noncanonical.push(row.id);
      const key = normalized.toLowerCase();
      names.set(key, [...(names.get(key) ?? []), row.id]);
    }
    const duplicates = [...names.values()].filter(group => group.length > 1);
    if (noncanonical.length || duplicates.length) {
      if (noncanonical.length) console.error(`NFC 정규화·앞뒤 공백 확인이 필요한 활성 계정 ${noncanonical.length}개: ${identifiers(noncanonical)}`);
      if (duplicates.length) console.error(`대소문자를 구분하지 않는 중복 닉네임 ${duplicates.length}그룹. 계정 id: ${identifiers(duplicates.flat())}`);
      console.error('운영자가 해당 닉네임을 정리한 뒤 다시 실행하세요. 이 검사는 DB를 변경하지 않았습니다.');
      process.exitCode = 1;
    } else {
      console.log(`닉네임 사전 검사 통과: 활성 사용자 ${rows.length}명, 중복 없음. DB를 변경하지 않았습니다.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error && error.message === 'INVALID_RESPONSE'
    ? '닉네임 사전 검사 실패: Wrangler 응답 형식을 확인할 수 없습니다. 마이그레이션을 진행하지 마세요.'
    : '원격 닉네임 사전 검사를 완료하지 못했습니다. Wrangler 인증·연결을 확인한 뒤 다시 실행하세요.');
  process.exitCode = 1;
}
