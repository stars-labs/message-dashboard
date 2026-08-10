// Run with: bun test client/lib/device-status.test.js
import { describe, expect, test } from 'bun:test';
import { getStatusMeta, isAnomalous } from './device-status.js';

describe('getStatusMeta', () => {
  test('known active status returns 在线', () => {
    expect(getStatusMeta('active').label).toBe('在线');
  });

  test('known sim_error returns correct classes', () => {
    const m = getStatusMeta('sim_error');
    expect(m.label).toBe('读卡失败');
    expect(m.dotClass).toContain('red');
    expect(m.rowClass).toBeTruthy();
  });

  test('unassigned and no_modem both map to 待映射', () => {
    expect(getStatusMeta('unassigned').label).toBe('待映射');
    expect(getStatusMeta('no_modem').label).toBe('待映射');
  });

  test('unknown string falls back gracefully (does not throw)', () => {
    const m = getStatusMeta('searching'); // old PhoneList-invented value
    expect(m).toBeTruthy();
    expect(m.label).toBe('离线'); // fallback
  });

  test('null and undefined fall back gracefully', () => {
    expect(getStatusMeta(null).label).toBe('离线');
    expect(getStatusMeta(undefined).label).toBe('离线');
  });
});

describe('isAnomalous', () => {
  test('active is not anomalous', () => {
    expect(isAnomalous('active')).toBe(false);
  });

  test('offline is not anomalous (no action needed)', () => {
    expect(isAnomalous('offline')).toBe(false);
  });

  test('sim_error, iccid_mismatch, unassigned, no_modem are anomalous', () => {
    expect(isAnomalous('sim_error')).toBe(true);
    expect(isAnomalous('iccid_mismatch')).toBe(true);
    expect(isAnomalous('unassigned')).toBe(true);
    expect(isAnomalous('no_modem')).toBe(true);
  });
});
