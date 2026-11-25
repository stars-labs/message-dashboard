import { describe, expect, test } from 'bun:test';
import type { BalanceCheck, BalanceMetric } from '../../../shared/api/balance-checks.js';
import { buildBalanceRows } from '../balance-overview.js';
import { compareHistoryChecks, compareOverviewRows } from './sort.js';
import type {
  BalancePhone,
  BalanceRow,
  HistorySortKey,
  OverviewSortKey,
  SortDirection,
} from './types.js';

const now = new Date('2026-08-14T08:00:00Z');

function cash(value: number | null, currency: string | null): BalanceMetric {
  return { metric_type: 'cash_balance', value, unit: null, currency, expires_at: null };
}

function row(phone: Partial<BalancePhone>, fields: Partial<BalanceRow> = {}): BalanceRow {
  const [built] = buildBalanceRows(
    [
      {
        iccid: 'iccid-1',
        sim_index: 1,
        number: '',
        carrier: null,
        country: null,
        service_type: 'unknown',
        sim_role: 'primary',
        primary_iccid: null,
        balance_threshold: null,
        flag: '',
        ...phone,
      },
    ],
    [],
    now,
  );
  if (built === undefined) throw new Error('buildBalanceRows returned no row');
  return { ...built, ...fields };
}

function check(overrides: Partial<BalanceCheck>): BalanceCheck {
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
    profile_carrier: '',
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

function overview(
  rows: BalanceRow[],
  key: OverviewSortKey | null,
  direction: SortDirection = 'asc',
): string[] {
  return rows
    .toSorted((left, right) => compareOverviewRows(left, right, key, direction))
    .map((sorted) => sorted.phone.iccid);
}

function history(
  checks: BalanceCheck[],
  key: HistorySortKey,
  direction: SortDirection = 'asc',
): string[] {
  return checks
    .toSorted((left, right) => compareHistoryChecks(left, right, key, direction))
    .map((sorted) => sorted.id);
}

describe('overview rows', () => {
  test('without a sort key, put the most urgent health first, then SIM order with S00 last', () => {
    const rows = [
      row({ iccid: 'healthy', sim_index: 1 }, { health: 'healthy' }),
      row({ iccid: 'unslotted', sim_index: 0 }, { health: 'expired' }),
      row({ iccid: 'expired', sim_index: 5 }, { health: 'expired' }),
      row({ iccid: 'low', sim_index: 2 }, { health: 'low_balance' }),
    ];

    expect(overview(rows, null)).toEqual(['expired', 'unslotted', 'low', 'healthy']);
  });

  test('sorts by a column in either direction and breaks ties by SIM', () => {
    const rows = [
      row({ iccid: 'b', sim_index: 3, carrier: '联通' }),
      row({ iccid: 'a', sim_index: 1, carrier: '联通' }),
      row({ iccid: 'c', sim_index: 2, carrier: '电信' }),
    ];

    expect(overview(rows, 'sim')).toEqual(['a', 'c', 'b']);
    expect(overview(rows, 'sim', 'desc')).toEqual(['b', 'c', 'a']);
    expect(overview(rows, 'carrier')).toEqual(['c', 'a', 'b']);
  });

  test('compares balances by currency, then amount, and puts a missing balance last', () => {
    const rows = [
      row({ iccid: 'none', sim_index: 1 }, { balanceMetric: null }),
      row({ iccid: 'sgd-5', sim_index: 2 }, { balanceMetric: cash(5, 'SGD') }),
      row({ iccid: 'cny-20', sim_index: 3 }, { balanceMetric: cash(20, 'CNY') }),
      row({ iccid: 'cny-3', sim_index: 4 }, { balanceMetric: cash(3, 'CNY') }),
    ];

    expect(overview(rows, 'balance')).toEqual(['cny-3', 'cny-20', 'sgd-5', 'none']);
  });

  test('compares thresholds by currency, then amount', () => {
    const rows = [
      row({ iccid: 'cny-10', sim_index: 1 }, { threshold: { value: 10, currency: 'CNY' } }),
      row({ iccid: 'none', sim_index: 2 }, { threshold: null }),
      row({ iccid: 'cny-5', sim_index: 3 }, { threshold: { value: 5, currency: 'CNY' } }),
    ];

    expect(overview(rows, 'threshold')).toEqual(['cny-5', 'cny-10', 'none']);
  });

  test('sorts by health, expiry, update time, query status and service type', () => {
    const early = row(
      { iccid: 'early', sim_index: 1, service_type: 'prepaid' },
      {
        health: 'expired',
        expiryDate: '2026-09-01',
        balanceTimestamp: '2026-08-01 00:00:00',
        latestCheck: check({ status: 'failed' }),
      },
    );
    const late = row(
      { iccid: 'late', sim_index: 2, service_type: 'postpaid' },
      {
        health: 'healthy',
        expiryDate: '2026-12-01',
        balanceTimestamp: '2026-08-10 00:00:00',
        latestCheck: check({ status: 'parsed' }),
      },
    );
    const blank = row(
      { iccid: 'blank', sim_index: 3, service_type: '' },
      { health: 'never_observed', expiryDate: null, balanceTimestamp: null, latestCheck: null },
    );
    const rows = [blank, late, early];

    expect(overview(rows, 'health')).toEqual(['early', 'blank', 'late']);
    expect(overview(rows, 'expiry')).toEqual(['early', 'late', 'blank']);
    expect(overview(rows, 'updated')).toEqual(['early', 'late', 'blank']);
    expect(overview(rows, 'query')).toEqual(['early', 'late', 'blank']);
    expect(overview(rows, 'service_type')).toEqual(['blank', 'late', 'early']);
  });

  test('leaves rows in SIM order for a key that has no column value', () => {
    const rows = [row({ iccid: 'b', sim_index: 2 }), row({ iccid: 'a', sim_index: 1 })];

    expect(overview(rows, 'sim_role')).toEqual(['a', 'b']);
  });
});

describe('history checks', () => {
  const older = check({
    id: 'older',
    sim_index: 2,
    profile_carrier: '',
    sim_carrier: 'Singtel',
    method: 'browser',
    status: 'parsed',
    requested_at: '2026-08-01 00:00:00',
    metrics: [cash(5, 'SGD')],
  });
  const newer = check({
    id: 'newer',
    sim_index: 1,
    profile_carrier: 'China Mobile',
    method: 'sms',
    status: 'failed',
    requested_at: '2026-08-10 00:00:00',
    metrics: [cash(2, 'SGD')],
  });
  const undated = check({
    id: 'undated',
    sim_index: 3,
    method: 'ussd',
    status: 'timed_out',
    requested_at: 'not a time',
  });
  const checks = [undated, newer, older];

  test('sorts by time, treating an unreadable time as the oldest', () => {
    expect(history(checks, 'time')).toEqual(['undated', 'older', 'newer']);
    expect(history(checks, 'time', 'desc')).toEqual(['newer', 'older', 'undated']);
  });

  test('sorts by SIM, carrier (profile first, then SIM), method, status and balance', () => {
    expect(history(checks, 'sim')).toEqual(['newer', 'older', 'undated']);
    expect(history(checks, 'carrier')).toEqual(['newer', 'older', 'undated']);
    expect(history(checks, 'method')).toEqual(['older', 'newer', 'undated']);
    expect(history(checks, 'status')).toEqual(['newer', 'older', 'undated']);
    expect(history(checks, 'balance')).toEqual(['newer', 'older', 'undated']);
  });

  test('breaks a tie by check ID', () => {
    const tied = [check({ id: 'b' }), check({ id: 'a' })];

    expect(history(tied, 'method')).toEqual(['a', 'b']);
    expect(history(tied, 'method', 'desc')).toEqual(['b', 'a']);
  });
});
