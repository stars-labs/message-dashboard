import { describe, expect, test } from 'bun:test';
import { findKeywordMatches } from './keyword-match.js';

describe('findKeywordMatches', () => {
  test('returns nothing for empty text or keyword', () => {
    expect(findKeywordMatches('', 'code')).toEqual([]);
    expect(findKeywordMatches(null, 'code')).toEqual([]);
    expect(findKeywordMatches(undefined, 'code')).toEqual([]);
    expect(findKeywordMatches('your code', '')).toEqual([]);
    expect(findKeywordMatches('your code', null)).toEqual([]);
    expect(findKeywordMatches('your code', undefined)).toEqual([]);
  });

  test('finds every occurrence, case-insensitively by default, keeping the original casing', () => {
    expect(findKeywordMatches('Code and CODE and code', 'code')).toEqual([
      { text: 'Code', position: 0 },
      { text: 'CODE', position: 9 },
      { text: 'code', position: 18 },
    ]);
  });

  test('respects case sensitivity', () => {
    expect(findKeywordMatches('Code and code', 'code', true)).toEqual([
      { text: 'code', position: 9 },
    ]);
  });

  test('matches substrings unless whole-word is requested', () => {
    expect(findKeywordMatches('decoded code', 'code')).toEqual([
      { text: 'code', position: 2 },
      { text: 'code', position: 8 },
    ]);
    expect(findKeywordMatches('decoded code', 'code', false, true)).toEqual([
      { text: 'code', position: 8 },
    ]);
  });

  test('whole-word matching honours case sensitivity', () => {
    expect(findKeywordMatches('Code code', 'code', true, true)).toEqual([
      { text: 'code', position: 5 },
    ]);
    expect(findKeywordMatches('Code code', 'code', false, true)).toHaveLength(2);
  });

  test('does not report overlapping occurrences', () => {
    expect(findKeywordMatches('aaaa', 'aa')).toEqual([
      { text: 'aa', position: 0 },
      { text: 'aa', position: 2 },
    ]);
  });

  test('treats regex metacharacters in a whole-word keyword literally', () => {
    expect(findKeywordMatches('pay $5 (now)', '(now)', false, true)).toEqual([]);
    expect(findKeywordMatches('a.b axb', 'a.b', false, true)).toEqual([
      { text: 'a.b', position: 0 },
    ]);
  });
});
