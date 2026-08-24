import { describe, expect, test } from 'bun:test';
import { buildBalanceRows, countBalanceHealth, getBalanceThreshold } from './balance-overview.js';

const now = new Date('2026-08-14T08:00:00Z');

function phone(iccid, country) {
  return { iccid, country, sim_index: Number(iccid.slice(-1)) || 1 };
}

function check(iccid, status, value, currency, requestedAt = '2026-08-14 07:00:00') {
  return {
    id: `${iccid}-${status}-${requestedAt}`,
    sim_iccid: iccid,
    status,
    requested_at: requestedAt,
    metrics: value == null ? [] : [{ metric_type: 'cash_balance', value, currency }],
  };
}

describe('balance overview', () => {
  test('uses the confirmed thresholds for China, Singapore and Hong Kong', () => {
    expect(getBalanceThreshold(phone('cn1', 'CN'))).toEqual({ value: 100, currency: 'CNY' });
    expect(getBalanceThreshold(phone('sg2', 'SG'))).toEqual({ value: 10, currency: 'SGD' });
    expect(getBalanceThreshold(phone('hk3', 'HK'))).toEqual({ value: 100, currency: 'HKD' });
  });

  test('a per-SIM balance_threshold overrides the currency default', () => {
    expect(getBalanceThreshold({ ...phone('cn1', 'CN'), balance_threshold: 50 }))
      .toEqual({ value: 50, currency: 'CNY' });
  });

  test('empty or null balance_threshold falls back to the currency default', () => {
    expect(getBalanceThreshold({ ...phone('cn1', 'CN'), balance_threshold: null }))
      .toEqual({ value: 100, currency: 'CNY' });
    expect(getBalanceThreshold({ ...phone('cn1', 'CN'), balance_threshold: '' }))
      .toEqual({ value: 100, currency: 'CNY' });
  });

  test('a custom threshold affects the low-balance classification', () => {
    const phoneWithOverride = { ...phone('cn1', 'CN'), balance_threshold: 50 };
    const above = buildBalanceRows(
      [phoneWithOverride],
      [check('cn1', 'parsed', 60, 'CNY')],
      now
    );
    expect(above[0].health).toBe('healthy');

    const below = buildBalanceRows(
      [phoneWithOverride],
      [check('cn1', 'parsed', 40, 'CNY')],
      now
    );
    expect(below[0].health).toBe('low_balance');
  });

  test('classifies normal, low, stale and unknown balances', () => {
    const phones = [phone('cn1', 'CN'), phone('sg2', 'SG'), phone('hk3', 'HK'), phone('xx4', 'XX')];
    const checks = [
      check('cn1', 'parsed', 264.33, 'CNY'),
      check('sg2', 'parsed', 4.5, 'SGD'),
      check('hk3', 'parsed', 180, 'HKD', '2026-06-01 00:00:00'),
    ];
    const rows = buildBalanceRows(phones, checks, now);

    expect(rows.map((row) => row.health)).toEqual([
      'healthy',
      'low_balance',
      'stale',
      'never_observed',
    ]);
    expect(countBalanceHealth(rows)).toEqual({
      healthy: 1,
      zero_or_negative_balance: 0,
      low_balance: 1,
      stale: 1,
      query_failed: 0,
      never_observed: 1,
      expired: 0,
      expiring_soon: 0,
      verification_pending: 0,
      expiry_unknown: 0,
      not_applicable: 0,
    });
  });

  test('secondary SIMs inherit their primary balance and health classification', () => {
    const primary = {
      ...phone('primary1', 'CN'),
      sim_role: 'primary',
    };
    const secondary = {
      ...phone('secondary2', 'CN'),
      sim_role: 'secondary',
      primary_iccid: primary.iccid,
    };

    const rows = buildBalanceRows(
      [primary, secondary],
      [check(primary.iccid, 'parsed', 340.76, 'CNY')],
      now
    );

    expect(rows.map((row) => row.health)).toEqual(['healthy', 'healthy']);
    expect(rows[1].balanceMetric).toEqual(rows[0].balanceMetric);
    expect(rows[1].balanceTimestamp).toBe(rows[0].balanceTimestamp);
    expect(countBalanceHealth(rows)).toEqual({
      healthy: 2,
      zero_or_negative_balance: 0,
      low_balance: 0,
      stale: 0,
      query_failed: 0,
      never_observed: 0,
      expired: 0,
      expiring_soon: 0,
      verification_pending: 0,
      expiry_unknown: 0,
      not_applicable: 0,
    });
  });

  test('an orphan secondary remains unknown', () => {
    const orphan = {
      ...phone('secondary2', 'CN'),
      sim_role: 'secondary',
      primary_iccid: 'missing-primary',
    };

    const [row] = buildBalanceRows([orphan], [], now);

    expect(row.health).toBe('never_observed');
    expect(row.balanceMetric).toBeNull();
  });

  test('keeps the last known balance but gives a newer failed query priority', () => {
    const checks = [
      check('cn1', 'failed', null, null, '2026-08-14 07:30:00'),
      check('cn1', 'parsed', 264.33, 'CNY', '2026-08-14 07:00:00'),
    ];
    const [row] = buildBalanceRows([phone('cn1', 'CN')], checks, now);

    expect(row.health).toBe('query_failed');
    expect(row.balanceMetric.value).toBe(264.33);
    expect(row.latestCheck.status).toBe('failed');
  });

  test('cancelled checks are ignored for health — SIM falls back to unknown instead of failed', () => {
    const checks = [
      { ...check('cn1', 'failed', null, null, '2026-08-14 07:30:00'), error: 'Manually cancelled: Unicom rate limit in effect' },
      { ...check('cn1', 'failed', null, null, '2026-08-14 07:00:00'), error: 'Cancelled: China Unicom batch was triggered in error' },
    ];
    const [row] = buildBalanceRows([phone('cn1', 'CN')], checks, now);

    expect(row.health).toBe('never_observed');
    // latestCheck should be null — all checks were cancelled
    expect(row.latestCheck).toBeNull();
  });

  test('cancelled check does not shadow a real earlier failure', () => {
    const checks = [
      { ...check('cn1', 'failed', null, null, '2026-08-14 08:00:00'), error: 'Cancelled: triggered in error' },
      check('cn1', 'failed', null, null, '2026-08-14 07:00:00'),
    ];
    const [row] = buildBalanceRows([phone('cn1', 'CN')], checks, now);

    // The non-cancelled failed check should still drive the query-failed summary.
    expect(row.health).toBe('query_failed');
    expect(row.latestCheck.status).toBe('failed');
  });

  test('keeps low balance and approaching expiry as separate reasons', () => {
    const balance = check('sg2', 'parsed', 4.5, 'SGD');
    balance.metrics.push({
      metric_type: 'account_expiry',
      value: null,
      currency: null,
      expires_at: '2026-08-30',
    });

    const [row] = buildBalanceRows([
      { ...phone('sg2', 'SG'), service_type: 'prepaid' },
    ], [balance], now);

    expect(row.health).toBe('low_balance');
    expect(row.healthReasons).toEqual(expect.arrayContaining(['low_balance', 'expiring_soon']));
    expect(row.expiryDate).toBe('2026-08-30');
  });

  test('requires expiry when the selected profile promises account expiry', () => {
    const balance = {
      ...check('sg2', 'parsed', 12, 'SGD'),
      profile_outputs: ['cash_balance', 'account_expiry'],
    };

    const [row] = buildBalanceRows([
      { ...phone('sg2', 'SG'), service_type: 'prepaid' },
    ], [balance], now);

    expect(row.health).toBe('expiry_unknown');
    expect(row.healthReasons).toContain('expiry_unknown');
  });

  test('excludes postpaid SIMs from prepaid balance health', () => {
    const [row] = buildBalanceRows([
      { ...phone('sg2', 'SG'), service_type: 'postpaid' },
    ], [check('sg2', 'parsed', 0, 'SGD')], now);

    expect(row.health).toBe('not_applicable');
    expect(row.threshold).toBeNull();
    expect(row.healthReasons).toEqual([]);
  });
});
