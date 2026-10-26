import { afterEach, describe, expect, test } from 'bun:test';
import { activeKeywords, loadActiveKeywords, selectActiveKeywords } from './active-keywords.svelte.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('selectActiveKeywords', () => {
  test('keeps active rules, highest priority first', () => {
    const rules = [
      { id: 'a', is_active: 1, priority: 1 },
      { id: 'b', is_active: 0, priority: 9 },
      { id: 'c', is_active: 1, priority: 5 },
      { id: 'd', is_active: 1 },
    ];
    expect(selectActiveKeywords(rules).map((rule) => rule.id)).toEqual(['c', 'a', 'd']);
  });

  test('treats a missing list as empty', () => {
    expect(selectActiveKeywords(undefined)).toEqual([]);
  });
});

describe('loadActiveKeywords', () => {
  test('concurrent loads share one request', async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return Response.json({ keywords: [{ id: 'k', keyword: '验证码', is_active: 1 }] });
    };

    await Promise.all([loadActiveKeywords(), loadActiveKeywords()]);

    expect(requests).toBe(1);
    expect(activeKeywords().map((rule) => rule.id)).toEqual(['k']);
  });

  test('a failed load leaves no rules', async () => {
    globalThis.fetch = async () => Response.json({ error: 'down' }, { status: 500 });

    await loadActiveKeywords();

    expect(activeKeywords()).toEqual([]);
  });
});
