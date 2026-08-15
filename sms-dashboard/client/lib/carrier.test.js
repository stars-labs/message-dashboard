import { describe, expect, test } from 'bun:test';
import { buildCarrierOptions, carrierKey, carrierLabel } from './carrier.js';

describe('carrier normalization', () => {
  test('groups Chinese and English mainland carrier names', () => {
    expect(carrierKey('电信')).toBe('china-telecom');
    expect(carrierKey('China Telecom')).toBe('china-telecom');
    expect(carrierKey('中国联通')).toBe('china-unicom');
    expect(carrierLabel('China Mobile')).toBe('移动');
  });

  test('builds one localized option for duplicate aliases', () => {
    expect(buildCarrierOptions([
      '电信', 'China Telecom', '联通', 'China Unicom', 'Singtel',
    ])).toEqual(expect.arrayContaining([
      { key: 'china-telecom', label: '电信' },
      { key: 'china-unicom', label: '联通' },
      { key: 'singtel', label: 'Singtel' },
    ]));
    expect(buildCarrierOptions(['电信', 'China Telecom'])).toHaveLength(1);
  });
});
