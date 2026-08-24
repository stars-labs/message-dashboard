import { describe, expect, test } from 'bun:test';
import { evaluatePrepaidHealth } from './prepaid-health.js';

const now = new Date('2026-08-24T04:00:00Z');

function evaluate(overrides = {}) {
  return evaluatePrepaidHealth({
    serviceType: 'prepaid',
    country: 'SG',
    now,
    threshold: { value: 10, currency: 'SGD' },
    cashBalance: {
      value: 20,
      currency: 'SGD',
      observedAt: '2026-08-24T03:00:00Z',
    },
    ...overrides,
  });
}

describe('prepaid health policy', () => {
  test('treats the low-balance threshold as an exclusive boundary', () => {
    expect(evaluate({ cashBalance: {
      value: 10,
      currency: 'SGD',
      observedAt: '2026-08-24T03:00:00Z',
    } }).summaryStatus).toBe('healthy');

    const low = evaluate({ cashBalance: {
      value: 9.99,
      currency: 'SGD',
      observedAt: '2026-08-24T03:00:00Z',
    } });
    expect(low.summaryStatus).toBe('low_balance');
    expect(low.reasons).toContain('low_balance');
  });

  test('gives zero balance higher priority than low balance without hiding either reason', () => {
    const result = evaluate({ cashBalance: {
      value: 0,
      currency: 'SGD',
      observedAt: '2026-08-24T03:00:00Z',
    } });

    expect(result.summaryStatus).toBe('zero_or_negative_balance');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'zero_or_negative_balance',
      'low_balance',
    ]));
  });

  test('preserves simultaneous low-balance and expiry reasons', () => {
    const result = evaluate({
      cashBalance: {
        value: 5,
        currency: 'SGD',
        observedAt: '2026-08-24T03:00:00Z',
      },
      accountExpiry: {
        date: '2026-09-03',
        observedAt: '2026-08-24T03:00:00Z',
      },
    });

    expect(result.summaryStatus).toBe('low_balance');
    expect(result.reasons).toEqual(expect.arrayContaining(['low_balance', 'expiring_soon']));
  });

  test('marks old observations stale while retaining their low-balance evidence', () => {
    const result = evaluate({ cashBalance: {
      value: 5,
      currency: 'SGD',
      observedAt: '2026-07-19T03:00:00Z',
    } });

    expect(result.summaryStatus).toBe('stale');
    expect(result.reasons).toEqual(expect.arrayContaining(['stale', 'low_balance']));
  });

  test('uses regional calendar dates for expired and 30-day expiry boundaries', () => {
    expect(evaluate({ accountExpiry: { date: '2026-08-23' } }).summaryStatus)
      .toBe('expired');
    expect(evaluate({ accountExpiry: { date: '2026-08-24' } }).reasons)
      .toContain('expiring_soon');
    expect(evaluate({ accountExpiry: { date: '2026-09-23' } }).reasons)
      .toContain('expiring_soon');
    expect(evaluate({ accountExpiry: { date: '2026-09-24' } }).reasons)
      .not.toContain('expiring_soon');
  });

  test('reports failed queries without discarding the last observation', () => {
    const result = evaluate({ latestQueryStatus: 'timed_out' });

    expect(result.summaryStatus).toBe('query_failed');
    expect(result.reasons).toContain('query_failed');
    expect(result.reasons).not.toContain('never_observed');
  });

  test('distinguishes never-observed data from unsupported automation', () => {
    const missing = evaluate({ cashBalance: null });
    expect(missing.summaryStatus).toBe('never_observed');
    expect(missing.reasons).toContain('never_observed');

    const manual = evaluate({ automationSupported: false });
    expect(manual.summaryStatus).toBe('healthy');
    expect(manual.reasons).toContain('automation_unsupported');
  });

  test('requires expiry only when the selected profile promises it', () => {
    expect(evaluate({ accountExpiry: null, expiryExpected: false }).reasons)
      .not.toContain('expiry_unknown');

    const result = evaluate({ accountExpiry: null, expiryExpected: true });
    expect(result.summaryStatus).toBe('expiry_unknown');
    expect(result.reasons).toContain('expiry_unknown');
  });

  test('keeps recharge verification pending until a later workflow observation', () => {
    const result = evaluate({ verificationPending: true });

    expect(result.summaryStatus).toBe('verification_pending');
    expect(result.reasons).toContain('verification_pending');
  });

  test('excludes postpaid SIMs from prepaid health classification', () => {
    const result = evaluate({
      serviceType: 'postpaid',
      cashBalance: {
        value: 0,
        currency: 'SGD',
        observedAt: '2026-08-24T03:00:00Z',
      },
    });

    expect(result).toEqual({ summaryStatus: 'not_applicable', reasons: [] });
  });
});
