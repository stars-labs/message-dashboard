// Run with: bun test client/lib/message-highlight.test.js
import { describe, expect, test } from 'bun:test';
import { DEFAULT_KEYWORD_COLOR, getSegments, safeColor } from './message-highlight.js';

const kw = (over = {}) => ({
  keyword: 'code',
  tag: 'OTP',
  color: '#FF0000',
  case_sensitive: false,
  whole_word: false,
  ...over,
});

// Concatenating segments must always reproduce the trimmed input. This is the property
// that guarantees the rewrite away from {@html} did not garble displayed messages.
const rebuild = (segments, original) =>
  segments === null ? original.trim() : segments.map((s) => s.text).join('');

describe('getSegments — text is preserved exactly', () => {
  const cases = [
    'your code is 1234',
    'code',
    'code at the start',
    'ends with code',
    'code and code twice',
    'codecode adjacent',
    'no keyword here',
    '  leading and trailing  ',
    '验证码 code 1234 你好',
    'punctuation: code, code. code!',
    'multi\nline code here',
  ];

  for (const text of cases) {
    test(`round-trips ${JSON.stringify(text)}`, () => {
      const segments = getSegments(text, [kw()]);
      expect(rebuild(segments, text)).toBe(text.trim());
    });
  }

  test('round-trips with several overlapping keywords', () => {
    const text = 'your code is 1234 and the verification code follows';
    const segments = getSegments(text, [
      kw({ keyword: 'code' }),
      kw({ keyword: 'verification code', tag: 'VC' }),
      kw({ keyword: '1234', tag: 'NUM' }),
    ]);
    expect(rebuild(segments, text)).toBe(text.trim());
  });
});

describe('getSegments — matching', () => {
  test('marks the keyword and leaves surrounding text plain', () => {
    const segments = getSegments('your code is 1234', [kw()]);
    expect(segments).toEqual([
      { text: 'your ', match: null },
      { text: 'code', match: { color: '#FF0000', tag: 'OTP' } },
      { text: ' is 1234', match: null },
    ]);
  });

  test('returns null when nothing matches, so the caller renders raw text', () => {
    expect(getSegments('nothing here', [kw()])).toBeNull();
  });

  test('returns null with no keywords or no content', () => {
    expect(getSegments('your code', [])).toBeNull();
    expect(getSegments('', [kw()])).toBeNull();
    expect(getSegments(null, [kw()])).toBeNull();
  });

  test('is case-insensitive by default and preserves original casing', () => {
    const segments = getSegments('Your CODE is 1234', [kw()]);
    expect(segments[1]).toEqual({ text: 'CODE', match: { color: '#FF0000', tag: 'OTP' } });
  });

  test('respects case_sensitive', () => {
    expect(getSegments('Your CODE', [kw({ case_sensitive: true })])).toBeNull();
  });

  test('respects whole_word', () => {
    expect(getSegments('encoded message', [kw({ whole_word: true })])).toBeNull();
    expect(getSegments('the code here', [kw({ whole_word: true })])[1].text).toBe('code');
  });

  test('does not hang on a regex-special keyword', () => {
    const segments = getSegments('price is $5 (approx)', [kw({ keyword: '$5', whole_word: true })]);
    expect(rebuild(segments, 'price is $5 (approx)')).toBe('price is $5 (approx)');
  });

  test('ignores blank keywords', () => {
    expect(getSegments('some text', [kw({ keyword: '' }), kw({ keyword: null })])).toBeNull();
  });

  test('overlapping matches do not duplicate text', () => {
    const text = 'verification code';
    const segments = getSegments(text, [
      kw({ keyword: 'verification code', tag: 'VC' }),
      kw({ keyword: 'code', tag: 'OTP' }),
    ]);
    expect(rebuild(segments, text)).toBe(text);
    expect(segments.filter((s) => s.match).length).toBe(1);
  });
});

// The XSS payloads. The component binds match.color into style:--kw-color, so a
// non-hex value must never survive to the template.
describe('safeColor', () => {
  test('passes through valid hex', () => {
    expect(safeColor('#3B82F6')).toBe('#3B82F6');
    expect(safeColor('#f00')).toBe('#f00');
    expect(safeColor('  #f00a  ')).toBe('#f00a');
  });

  test('replaces an attribute break-out payload', () => {
    expect(safeColor('red" onmouseover="alert(1)')).toBe(DEFAULT_KEYWORD_COLOR);
    expect(safeColor('x"><img src=x onerror=alert(1)>')).toBe(DEFAULT_KEYWORD_COLOR);
  });

  test('replaces CSS injection attempts', () => {
    expect(safeColor('url(https://evil.example/x)')).toBe(DEFAULT_KEYWORD_COLOR);
    expect(safeColor('#fff;background:url(https://evil.example/x)')).toBe(DEFAULT_KEYWORD_COLOR);
  });

  test('replaces named colours and functional notation', () => {
    expect(safeColor('red')).toBe(DEFAULT_KEYWORD_COLOR);
    expect(safeColor('rgb(255,0,0)')).toBe(DEFAULT_KEYWORD_COLOR);
  });

  test('replaces missing or non-string values', () => {
    expect(safeColor(undefined)).toBe(DEFAULT_KEYWORD_COLOR);
    expect(safeColor(null)).toBe(DEFAULT_KEYWORD_COLOR);
    expect(safeColor(123)).toBe(DEFAULT_KEYWORD_COLOR);
    expect(safeColor({})).toBe(DEFAULT_KEYWORD_COLOR);
  });

  // End-to-end through getSegments: a payload stored on the keyword row must arrive at
  // the template already neutralised.
  test('a malicious stored colour is neutralised in the segments', () => {
    const segments = getSegments('your code is 1234', [
      kw({ color: 'red" onmouseover="fetch(\'//evil\')' }),
    ]);
    expect(segments[1].match.color).toBe(DEFAULT_KEYWORD_COLOR);
  });
});
