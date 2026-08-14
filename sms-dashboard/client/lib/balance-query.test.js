import { describe, expect, test } from 'bun:test';
import {
  formatBalanceMetric,
  getBalanceMetricLabel,
  getBalanceStatusMeta,
  getBalanceTimestamp,
  getCashBalance,
  normalizeUtcTimestamp,
} from './balance-query.js';

describe('balance query presentation', () => {
  test('uses the latest conversation timestamp', () => {
    expect(getBalanceTimestamp({
      requested_at: '2026-08-14 04:00:00',
      response_timestamp: '2026-08-14T04:01:00.000Z',
    })).toBe('2026-08-14T04:01:00.000Z');
  });

  test('formats parsed cash balances', () => {
    const check = { metrics: [{ metric_type: 'cash_balance', value: 82.36, currency: 'CNY' }] };
    expect(getCashBalance(check).value).toBe(82.36);
    expect(formatBalanceMetric(getCashBalance(check))).toContain('82.36');
  });

  test('uses readable labels for known metrics and preserves unknown ones', () => {
    expect(getBalanceMetricLabel('cash_balance')).toBe('账户余额');
    expect(getBalanceMetricLabel('data_remaining')).toBe('剩余流量');
    expect(getBalanceMetricLabel('carrier_bonus')).toBe('carrier_bonus');
  });

  test('labels audit states and normalizes D1 timestamps', () => {
    expect(getBalanceStatusMeta('response_received').label).toBe('已收到回复');
    expect(normalizeUtcTimestamp('2026-08-14 04:01:00')).toBe('2026-08-14 04:01:00Z');
    expect(normalizeUtcTimestamp('2026-08-14T04:01:00Z')).toBe('2026-08-14T04:01:00Z');
  });
});
