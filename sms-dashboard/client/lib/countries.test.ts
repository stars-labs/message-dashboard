import { describe, expect, test } from 'bun:test';
import {
  getCarrierColor,
  getCountryFlag,
  getCountryName,
  getPhoneFlag,
  inferCountryFromNumber,
} from './countries.js';

describe('inferCountryFromNumber', () => {
  test('prefers the country stated on the phone row, then the mapped one', () => {
    expect(inferCountryFromNumber({ number: '+6591234567', country: 'HK' })).toBe('HK');
    expect(inferCountryFromNumber({ number: '+6591234567', mapped_country: 'CN' })).toBe('CN');
  });

  test('infers from the number when the row states no country', () => {
    expect(inferCountryFromNumber({ number: '+6591234567', country: '' })).toBe('SG');
    expect(inferCountryFromNumber({ number: '13800138000', country: null })).toBe('CN');
  });

  test('infers from a raw number by prefix and length', () => {
    expect(inferCountryFromNumber('+85291234567')).toBe('HK');
    expect(inferCountryFromNumber('91234567')).toBe('SG');
    expect(inferCountryFromNumber('+819012345678')).toBe('JP');
    expect(inferCountryFromNumber('+447700900123')).toBeNull();
  });

  test('has no country for a missing number', () => {
    expect(inferCountryFromNumber(null)).toBeNull();
    expect(inferCountryFromNumber({ number: null })).toBeNull();
  });
});

describe('getPhoneFlag', () => {
  test('flags an inferred country, and a phone glyph when none is known', () => {
    expect(getPhoneFlag({ number: '+6591234567' })).toBe('🇸🇬');
    expect(getPhoneFlag({ number: '+447700900123' })).toBe('📱');
  });
});

describe('getCarrierColor', () => {
  test('colours each known carrier and greys an unknown one', () => {
    expect(getCarrierColor('中国移动')).toContain('blue');
    expect(getCarrierColor('Singtel')).toContain('teal');
    expect(getCarrierColor('Vodafone')).toContain('stone');
    expect(getCarrierColor(null)).toBe('');
  });
});

describe('country lookup', () => {
  test('names and flags a listed code', () => {
    expect(getCountryFlag('SG')).toBe('🇸🇬');
    expect(getCountryName('HK')).toBe('香港');
  });

  test('treats an unlisted code as unknown, even one Object.prototype has', () => {
    expect(getCountryFlag('constructor')).toBe('🌍');
    expect(getCountryName('toString')).toBe('toString');
  });

  test('has a globe and no name for a missing code', () => {
    expect(getCountryFlag(null)).toBe('🌍');
    expect(getCountryFlag('')).toBe('🌍');
    expect(getCountryName(null)).toBe('');
    expect(getCountryName('')).toBe('');
  });
});
