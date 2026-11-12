// The client-side keyword fallback is the only tag source when the server has
// not classified a message yet, so its counts drive the tag chips the operator
// scans. These tests pin the grouping rules rather than the store plumbing.

import { describe, expect, test } from 'bun:test';
import { tagService } from './tag-store.js';

const keyword = (overrides) => ({
  keyword: 'urgent',
  tag: 'urgent',
  color: '#ff0000',
  case_sensitive: false,
  whole_word: true,
  ...overrides,
});

describe('tagService.extractClientTags keyword grouping', () => {
  test('sums every occurrence of one keyword', () => {
    const tags = tagService._performKeywordMatching(
      'urgent now and urgent later',
      [keyword()],
    );

    expect(tags).toEqual([{ tag: 'urgent', color: '#ff0000', count: 2 }]);
  });

  test('sums matches across keywords that share a tag', () => {
    // Two phrases feed the same tag, so the chip shows the combined count.
    const tags = tagService._performKeywordMatching(
      'urgent and asap',
      [
        keyword({ keyword: 'urgent', tag: 'priority' }),
        keyword({ keyword: 'asap', tag: 'priority' }),
      ],
    );

    expect(tags).toEqual([{ tag: 'priority', color: '#ff0000', count: 2 }]);
  });

  test('keeps the colour of the keyword that introduced the tag', () => {
    const tags = tagService._performKeywordMatching(
      'urgent and asap',
      [
        keyword({ keyword: 'urgent', tag: 'priority', color: '#aa0000' }),
        keyword({ keyword: 'asap', tag: 'priority', color: '#00aa00' }),
      ],
    );

    expect(tags[0].color).toBe('#aa0000');
  });

  test('omits keywords that do not occur', () => {
    const tags = tagService._performKeywordMatching(
      'nothing to see here',
      [keyword({ keyword: 'absent', tag: 'absent' })],
    );

    expect(tags).toEqual([]);
  });
});