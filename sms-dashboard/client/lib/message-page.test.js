import { describe, expect, test } from 'bun:test';
import {
  MESSAGE_PAGE_SIZE,
  hasMoreMessages,
  mergeMessagePage,
  nextMessageOffset,
} from './message-page.js';

const message = (id, timestamp) => ({ id, timestamp, content: id });

describe('message pagination', () => {
  test('uses a bounded first page', () => {
    expect(MESSAGE_PAGE_SIZE).toBe(100);
  });

  test('replaces the current scope and sorts newest first', () => {
    const result = mergeMessagePage(
      [message('old-scope', '2026-08-20T00:00:00Z')],
      [
        message('older', '2026-08-21T00:00:00Z'),
        message('newer', '2026-08-22T00:00:00Z'),
      ],
      { replace: true },
    );

    expect(result.map(({ id }) => id)).toEqual(['newer', 'older']);
  });

  test('merges a poll into loaded history without duplicates', () => {
    const current = [
      message('two', '2026-08-22T00:00:00Z'),
      message('one', '2026-08-21T00:00:00Z'),
    ];
    const updatedTwo = { ...message('two', '2026-08-22T00:00:00Z'), content: 'updated' };
    const result = mergeMessagePage(
      current,
      [message('three', '2026-08-23T00:00:00Z'), updatedTwo],
    );

    expect(result.map(({ id }) => id)).toEqual(['three', 'two', 'one']);
    expect(result.find(({ id }) => id === 'two').content).toBe('updated');
  });

  test('uses the loaded unique count as the next offset', () => {
    expect(nextMessageOffset([message('a'), message('a'), message('b')])).toBe(2);
  });

  test('reports whether the server has another page', () => {
    expect(hasMoreMessages({ has_more: true })).toBe(true);
    expect(hasMoreMessages({ has_more: false })).toBe(false);
    expect(hasMoreMessages()).toBe(false);
  });
});
