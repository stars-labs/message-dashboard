import { describe, expect, test } from 'bun:test';
import { getCountryFlag, getCountryName } from './countries.js';

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
