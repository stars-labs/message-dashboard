import { describe, expect, test } from 'bun:test';
import { textOr } from './text.js';

describe('textOr', () => {
  test('keeps text, including whitespace', () => {
    expect(textOr('reason', 'fallback')).toBe('reason');
    expect(textOr(' ', 'fallback')).toBe(' ');
  });

  test('falls back for absent or empty text', () => {
    expect(textOr(undefined, 'fallback')).toBe('fallback');
    expect(textOr(null, 'fallback')).toBe('fallback');
    expect(textOr('', 'fallback')).toBe('fallback');
  });
});
