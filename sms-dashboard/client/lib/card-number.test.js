// Run with: bun test client/lib/card-number.test.js
import { describe, expect, test } from 'bun:test';
import { formatCardNumber, cardLabel } from './card-number.js';

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

describe('cardLabel', () => {
  test('formats with 号卡 suffix', () => {
    expect(cardLabel(5)).toBe('05 号卡');
    expect(cardLabel(80)).toBe('80 号卡');
  });

  test('null returns fallback', () => {
    expect(cardLabel(null)).toBe('未知卡');
  });
});
