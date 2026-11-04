import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime, formatTimeSeconds } from '../src/format';

describe('KST display formatting', () => {
  it('pads date and clock values without changing their KST meaning', () => {
    expect(formatDate('2026-01-04')).toBe('2026년 01월 04일');
    expect(formatTime('17:30')).toBe('17시 30분');
    expect(formatTime('17:30:00')).toBe('17시 30분');
    expect(formatTimeSeconds('09:12:36')).toBe('09시 12분 36초');
    expect(formatTimeSeconds('00:00')).toBe('00시 00분 00초');
  });
  it('converts ISO offsets through midnight and year boundaries', () => {
    expect(formatDateTime('2026-11-04T08:30:00Z')).toBe('2026년 11월 04일 17시 30분');
    expect(formatDate('2026-12-31T15:00:00Z')).toBe('2027년 01월 01일');
    expect(formatTimeSeconds('2026-12-31T15:00:36Z')).toBe('00시 00분 36초');
    expect(formatDateTime('2026-11-04T17:30:00+09:00')).toBe('2026년 11월 04일 17시 30분');
    expect(formatDateTime('2026-11-04T17:30:00')).toBe('2026년 11월 04일 17시 30분');
  });
  it('keeps missing or invalid display data readable', () => {
    expect(formatDate('—')).toBe('—');
    expect(formatTime('')).toBe('');
    expect(formatDateTime('invalid')).toBe('invalid');
  });
});
