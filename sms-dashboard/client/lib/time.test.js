import { describe, expect, test } from 'bun:test';
import { formatTimeAgo, toEpochMilliseconds } from './time.js';

describe('toEpochMilliseconds', () => {
  test('accepts epoch milliseconds and numeric strings', () => {
    expect(toEpochMilliseconds(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMilliseconds('1700000000000')).toBe(1_700_000_000_000);
  });

  test('treats D1 timestamps without a suffix as UTC', () => {
    expect(toEpochMilliseconds('2026-08-11 10:20:00')).toBe(Date.parse('2026-08-11T10:20:00Z'));
  });

  test('rejects missing and invalid timestamps', () => {
    expect(toEpochMilliseconds(null)).toBeNull();
    expect(toEpochMilliseconds('not-a-date')).toBeNull();
  });
});

describe('formatTimeAgo', () => {
  const now = Date.parse('2026-08-11T10:30:00Z');

  test('formats D1 timestamp strings', () => {
    expect(formatTimeAgo('2026-08-11 10:20:00', now)).toBe('10分钟前');
  });

  test('handles invalid, absent, and future timestamps', () => {
    expect(formatTimeAgo('not-a-date', now)).toBe('未知');
    expect(formatTimeAgo(null, now)).toBe('从未');
    expect(formatTimeAgo('2026-08-11T10:31:00Z', now)).toBe('刚刚');
  });
});
