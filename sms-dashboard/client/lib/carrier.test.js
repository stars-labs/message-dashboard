import { describe, expect, test } from 'bun:test';
import { buildCarrierOptions, carrierKey, carrierLabel } from './carrier.js';

describe('carrier normalization', () => {
  test('groups Chinese and English mainland carrier names', () => {
    expect(carrierKey({ carrier: '电信', country: 'CN' })).toBe('china-telecom');
    expect(carrierKey({ carrier: 'China Telecom', country: 'CN' })).toBe('china-telecom');
    expect(carrierKey({ carrier: '中国联通', country: 'CN' })).toBe('china-unicom');
    expect(carrierLabel({ carrier: 'China Mobile', country: 'CN' })).toBe('移动');
  });

  test('uses the SIM country to distinguish CMHK from mainland China Mobile', () => {
    expect(carrierKey({ carrier: '移动', country: 'HK' })).toBe('cmhk');
    expect(carrierKey({ carrier: '移动', country: 'CN' })).toBe('china-mobile');
    expect(carrierLabel({ carrier: '移动', country: 'HK' })).toBe('CMHK');
  });

  test('builds one localized option for duplicate aliases', () => {
    expect(buildCarrierOptions([
      { carrier: '电信', country: 'CN' },
      { carrier: 'China Telecom', country: 'CN' },
      { carrier: '联通', country: 'CN' },
      { carrier: 'China Unicom', country: 'CN' },
      { carrier: 'Singtel', country: 'SG' },
    ])).toEqual(expect.arrayContaining([
      { key: 'china-telecom', label: '电信' },
      { key: 'china-unicom', label: '联通' },
      { key: 'singtel', label: 'Singtel' },
    ]));
    expect(buildCarrierOptions([
      { carrier: '电信', country: 'CN' },
      { carrier: 'China Telecom', country: 'CN' },
    ])).toHaveLength(1);
  });

  test('builds separate options for Hong Kong and mainland Mobile records', () => {
    expect(buildCarrierOptions([
      { carrier: '移动', country: 'CN' },
      { carrier: '移动', country: 'HK' },
    ])).toEqual(expect.arrayContaining([
      { key: 'china-mobile', label: '移动' },
      { key: 'cmhk', label: 'CMHK' },
    ]));
  });
});
