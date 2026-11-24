import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { get } from 'svelte/store';
import type { Keyword } from '../../shared/api/keywords.js';
import { auth } from './auth.js';
import { keywords, tagActions } from './tag-store.js';

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
});

function answer(response: () => Response): void {
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => Promise.resolve(response()), { preconnect: () => undefined }),
  );
}

function keyword(id: number, overrides: Partial<Keyword> = {}) {
  return {
    id,
    keyword: `k${String(id)}`,
    tag: 'OTP',
    color: null,
    priority: 0,
    is_active: 1,
    case_sensitive: 0,
    whole_word: 0,
    created_by: null,
    created_at: null,
    updated_at: null,
    usage_count: 0,
    ...overrides,
  };
}

describe('loadKeywords', () => {
  test('keeps the active keywords, highest priority first', async () => {
    answer(() =>
      Response.json({
        keywords: [
          keyword(1, { priority: 1 }),
          keyword(2, { priority: 5 }),
          keyword(3, { priority: 9, is_active: 0 }),
          keyword(4, { priority: null }),
        ],
      }),
    );

    const loaded = await tagActions.loadKeywords();

    expect(loaded.map((k) => k.id)).toEqual([2, 1, 4]);
    expect(get(keywords).map((k) => k.id)).toEqual([2, 1, 4]);
  });

  test('empties the list when the keywords cannot be loaded', async () => {
    answer(() => Response.json({ error: 'down' }, { status: 503 }));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await tagActions.loadKeywords()).toEqual([]);
    expect(get(keywords)).toEqual([]);
    errorSpy.mockRestore();
  });
});
