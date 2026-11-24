import { describe, expect, test } from 'bun:test';
import type { BalanceCheck, BalanceMetric } from '../../shared/api/balance-checks.js';
import type { Phone } from '../../shared/api/phones.js';
import { buildBalanceRows, countBalanceHealth, getBalanceThreshold } from './balance-overview.js';

const now = new Date('2026-08-14T08:00:00Z');

function metric(overrides: Partial<BalanceMetric> = {}): BalanceMetric {
  return {
    metric_type: 'cash_balance',
    value: null,
    unit: null,
    currency: null,
    expires_at: null,
    ...overrides,
  };
}

function phone(overrides: Partial<Phone> = {}): Phone {
  return {
    id: 'phone-1',
    imei: null,
    iccid: 'iccid-1',
    number: '+8613800000000',
    country: null,
    carrier: null,
    service_type: 'unknown',
    service_type_source: null,
    service_type_verified_at: null,
    sim_role: 'primary',
    primary_iccid: null,
    balance_threshold: null,
    status: 'online',
    signal: null,
    operator: null,
    manufacturer: null,
    model: null,
    usb_port: null,
    usb_path: null,
    last_usb_path: null,
    modem_status: null,
    sim_index: 1,
    notes: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function sim(iccid: string, country: string): Phone {
  return phone({ iccid, country, sim_index: Number(iccid.slice(-1)) || 1 });
}

function baseCheck(overrides: Partial<BalanceCheck> = {}): BalanceCheck {
  return {
    id: 'check-1',
    sim_iccid: 'iccid-1',
    profile_id: 'profile-1',
    requested_at: '2026-08-14 07:00:00',
    sent_at: null,
    completed_at: null,
    status: 'parsed',
    step_index: 0,
    response_sender: null,
    raw_response: null,
    error: null,
    parser_version: '1',
    country_code: 'CN',
    profile_carrier: 'carrier',
    method: 'sms',
    command: '',
    destination: null,
    conversation_steps: '[]',
    sim_index: null,
    sim_number: null,
    sim_carrier: null,
    sim_country: null,
    outbound_content: null,
    outbound_recipient: null,
    outbound_timestamp: null,
    outbound_status: null,
    response_content: null,
    response_phone_number: null,
    response_timestamp: null,
    skill_job_status: null,
    web_job_status: null,
    web_human_reason: null,
    display_status: 'parsed',
    profile_outputs: [],
    metrics: [],
    ...overrides,
  };
}

function check(
  iccid: string,
  status: BalanceCheck['status'],
  value: number | null,
  currency: string | null,
  requestedAt = '2026-08-14 07:00:00',
): BalanceCheck {
  return baseCheck({
    id: `${iccid}-${status}-${requestedAt}`,
    sim_iccid: iccid,
    status,
    requested_at: requestedAt,
    metrics: value === null ? [] : [metric({ value, currency })],
  });
}

describe('balance overview', () => {
  test('uses the confirmed thresholds for China, Singapore and Hong Kong', () => {
    expect(getBalanceThreshold(sim('cn1', 'CN'))).toEqual({ value: 100, currency: 'CNY' });
    expect(getBalanceThreshold(sim('sg2', 'SG'))).toEqual({ value: 10, currency: 'SGD' });
    expect(getBalanceThreshold(sim('hk3', 'HK'))).toEqual({ value: 100, currency: 'HKD' });
  });

  test('a per-SIM balance_threshold overrides the currency default', () => {
    expect(getBalanceThreshold({ ...sim('cn1', 'CN'), balance_threshold: 50 })).toEqual({
      value: 50,
      currency: 'CNY',
    });
  });

  test('a null balance_threshold falls back to the currency default', () => {
    expect(getBalanceThreshold({ ...sim('cn1', 'CN'), balance_threshold: null })).toEqual({
      value: 100,
      currency: 'CNY',
    });
  });

  test('a custom threshold affects the low-balance classification', () => {
    const phoneWithOverride = { ...sim('cn1', 'CN'), balance_threshold: 50 };
    const [above] = buildBalanceRows([phoneWithOverride], [check('cn1', 'parsed', 60, 'CNY')], now);
    expect(above?.health).toBe('healthy');

    const [below] = buildBalanceRows([phoneWithOverride], [check('cn1', 'parsed', 40, 'CNY')], now);
    expect(below?.health).toBe('low_balance');
  });

  test('classifies normal, low, stale and unknown balances', () => {
    const phones = [sim('cn1', 'CN'), sim('sg2', 'SG'), sim('hk3', 'HK'), sim('xx4', 'XX')];
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
    const counts = countBalanceHealth(rows);
    expect(counts.get('healthy')).toBe(1);
    expect(counts.get('zero_or_negative_balance')).toBe(0);
    expect(counts.get('low_balance')).toBe(1);
    expect(counts.get('stale')).toBe(1);
    expect(counts.get('query_failed')).toBe(0);
    expect(counts.get('never_observed')).toBe(1);
    expect(counts.get('expired')).toBe(0);
    expect(counts.get('expiring_soon')).toBe(0);
    expect(counts.get('verification_pending')).toBe(0);
    expect(counts.get('expiry_unknown')).toBe(0);
    expect(counts.get('not_applicable')).toBe(0);
  });

  test('secondary SIMs inherit their primary balance and health classification', () => {
    const primary = {
      ...sim('primary1', 'CN'),
      sim_role: 'primary',
    };
    const secondary = {
      ...sim('secondary2', 'CN'),
      sim_role: 'secondary',
      primary_iccid: primary.iccid,
    };

    const rows = buildBalanceRows(
      [primary, secondary],
      [check(primary.iccid, 'parsed', 340.76, 'CNY')],
      now,
    );

    expect(rows.map((row) => row.health)).toEqual(['healthy', 'healthy']);
    expect(rows[1]?.balanceMetric).toEqual(rows[0]?.balanceMetric);
    expect(rows[1]?.balanceTimestamp).toBe(rows[0]?.balanceTimestamp);
    const counts = countBalanceHealth(rows);
    expect(counts.get('healthy')).toBe(2);
    expect(counts.get('zero_or_negative_balance')).toBe(0);
    expect(counts.get('low_balance')).toBe(0);
    expect(counts.get('stale')).toBe(0);
    expect(counts.get('query_failed')).toBe(0);
    expect(counts.get('never_observed')).toBe(0);
    expect(counts.get('expired')).toBe(0);
    expect(counts.get('expiring_soon')).toBe(0);
    expect(counts.get('verification_pending')).toBe(0);
    expect(counts.get('expiry_unknown')).toBe(0);
    expect(counts.get('not_applicable')).toBe(0);
  });

  test('an orphan secondary remains unknown', () => {
    const orphan = {
      ...sim('secondary2', 'CN'),
      sim_role: 'secondary',
      primary_iccid: 'missing-primary',
    };

    const [row] = buildBalanceRows([orphan], [], now);

    expect(row?.health).toBe('never_observed');
    expect(row?.balanceMetric).toBeNull();
  });

  test('keeps the last known balance but gives a newer failed query priority', () => {
    const checks = [
      check('cn1', 'failed', null, null, '2026-08-14 07:30:00'),
      check('cn1', 'parsed', 264.33, 'CNY', '2026-08-14 07:00:00'),
    ];
    const [row] = buildBalanceRows([sim('cn1', 'CN')], checks, now);

    expect(row?.health).toBe('query_failed');
    expect(row?.balanceMetric?.value).toBe(264.33);
    expect(row?.latestCheck?.status).toBe('failed');
  });

  test('cancelled checks are ignored for health — SIM falls back to unknown instead of failed', () => {
    const checks = [
      {
        ...check('cn1', 'failed', null, null, '2026-08-14 07:30:00'),
        error: 'Manually cancelled: Unicom rate limit in effect',
      },
      {
        ...check('cn1', 'failed', null, null, '2026-08-14 07:00:00'),
        error: 'Cancelled: China Unicom batch was triggered in error',
      },
    ];
    const [row] = buildBalanceRows([sim('cn1', 'CN')], checks, now);

    expect(row?.health).toBe('never_observed');
    // latestCheck should be null — all checks were cancelled
    expect(row?.latestCheck).toBeNull();
  });

  test('cancelled check does not shadow a real earlier failure', () => {
    const checks = [
      {
        ...check('cn1', 'failed', null, null, '2026-08-14 08:00:00'),
        error: 'Cancelled: triggered in error',
      },
      check('cn1', 'failed', null, null, '2026-08-14 07:00:00'),
    ];
    const [row] = buildBalanceRows([sim('cn1', 'CN')], checks, now);

    // The non-cancelled failed check should still drive the query-failed summary.
    expect(row?.health).toBe('query_failed');
    expect(row?.latestCheck?.status).toBe('failed');
  });

  test('keeps low balance and approaching expiry as separate reasons', () => {
    const balance = check('sg2', 'parsed', 4.5, 'SGD');
    balance.metrics.push(metric({ metric_type: 'account_expiry', expires_at: '2026-08-30' }));

    const [row] = buildBalanceRows(
      [{ ...sim('sg2', 'SG'), service_type: 'prepaid' }],
      [balance],
      now,
    );

    expect(row?.health).toBe('low_balance');
    expect(row?.healthReasons).toContain('low_balance');
    expect(row?.healthReasons).toContain('expiring_soon');
    expect(row?.expiryDate).toBe('2026-08-30');
  });

  test('requires expiry when the selected profile promises account expiry', () => {
    const balance = {
      ...check('sg2', 'parsed', 12, 'SGD'),
      profile_outputs: ['cash_balance', 'account_expiry'],
    };

    const [row] = buildBalanceRows(
      [{ ...sim('sg2', 'SG'), service_type: 'prepaid' }],
      [balance],
      now,
    );

    expect(row?.health).toBe('expiry_unknown');
    expect(row?.healthReasons).toContain('expiry_unknown');
  });

  test('excludes postpaid SIMs from prepaid balance health', () => {
    const [row] = buildBalanceRows(
      [{ ...sim('sg2', 'SG'), service_type: 'postpaid' }],
      [check('sg2', 'parsed', 0, 'SGD')],
      now,
    );

    expect(row?.health).toBe('not_applicable');
    expect(row?.threshold).toBeNull();
    expect(row?.healthReasons).toEqual([]);
  });
});
