// Run with: bun test client/lib/card-number.test.js
import { describe, expect, test } from 'bun:test';
import { formatCardNumber } from './card-number.js';

describe('formatCardNumber', () => {
  test('single digit is zero-padded', () => {
    expect(formatCardNumber(5)).toBe('05');
    expect(formatCardNumber(1)).toBe('01');
  });

  test('two-digit number is unchanged', () => {
    expect(formatCardNumber(42)).toBe('42');
    expect(formatCardNumber(95)).toBe('95');
  });

  test('null and undefined return dash', () => {
    expect(formatCardNumber(null)).toBe('—');
    expect(formatCardNumber(undefined)).toBe('—');
  });
});
