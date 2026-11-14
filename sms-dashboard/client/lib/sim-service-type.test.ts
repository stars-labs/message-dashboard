import { describe, expect, test } from 'bun:test';
import { getSimServiceTypeLabel, getSimServiceTypeSourceLabel } from './sim-service-type.js';

describe('SIM service type presentation', () => {
  test('labels confirmed and unknown values', () => {
    expect(getSimServiceTypeLabel('prepaid')).toBe('预付费');
    expect(getSimServiceTypeLabel('postpaid')).toBe('后付费');
    expect(getSimServiceTypeLabel('balance_managed')).toBe('按余额管理');
    expect(getSimServiceTypeLabel('n/a')).toBe('待确认');
    expect(getSimServiceTypeLabel('unknown')).toBe('待确认');
    expect(getSimServiceTypeLabel(null)).toBe('待确认');
  });

  test('labels controlled verification sources', () => {
    expect(getSimServiceTypeSourceLabel('carrier_account')).toBe('运营商 App / 门户');
    expect(getSimServiceTypeSourceLabel('invalid')).toBe('—');
  });
});
