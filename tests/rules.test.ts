import { describe, expect, it } from 'vitest';
import { kstDate, kstTimestamp, validValue, valueDifference, weekStart } from '../worker/rules';
import { hashPassword, verifyPassword, hashToken, randomToken } from '../worker/crypto';

describe('Korean day and weekly boundaries', () => {
  it('starts the new day at UTC 15:00 and the new week on KST Monday', () => {
    expect(kstDate(new Date('2026-11-01T14:59:59Z'))).toBe('2026-11-01');
    expect(kstDate(new Date('2026-11-01T15:00:00Z'))).toBe('2026-11-02');
    expect(weekStart(new Date('2026-11-01T14:59:59Z'))).toBe('2026-10-26');
    expect(weekStart(new Date('2026-11-01T15:00:00Z'))).toBe('2026-11-02');
    expect(kstTimestamp('2026-10-30', '10:30:00')).toBe(Date.parse('2026-10-30T01:30:00Z'));
  });
  it('validates exact value format without coercing out-of-range inputs', () => {
    expect(validValue('wake', '23:59:59')).toBe(true);
    for (const value of ['24:00:00', '9:30:00', '12:60:00', '12:00:60', '12:00', '', 930, null]) expect(validValue('wake', value)).toBe(false);
    for (const value of ['0', '50', '100']) expect(validValue('luck', value)).toBe(true);
    for (const value of ['101', '-1', '1.5', '01', '1e2', 50]) expect(validValue('luck', value)).toBe(false);
    expect(valueDifference('wake', '08:59:59', '09:01:00')).toBe(61);
    expect(valueDifference('luck', '0', '100')).toBe(100);
  });
});
describe('password and session secrets', () => {
  it('salts password hashes, checks passwords, and rejects malformed stored hashes', async () => {
    const password = 'a-test-password-123';
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword('wrong', first)).toBe(false);
    expect(await verifyPassword(password, 'bad-hash')).toBe(false);
    const token = randomToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashToken(token)).not.toBe(token);
  });
});
