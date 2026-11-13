import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { readKvJson, type KV } from './kv.js';

function storeWith(values: Record<string, string>): KV<'get'> {
  return { get: (key) => Promise.resolve(values[key] ?? null) };
}

const Tokens = v.array(v.string());

describe('readKvJson', () => {
  test('returns null when the key is absent', async () => {
    expect(await readKvJson(storeWith({}), 'k', Tokens)).toBeNull();
  });

  test('returns the value parsed by the schema', async () => {
    expect(await readKvJson(storeWith({ k: '["a","b"]' }), 'k', Tokens)).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
  });

  test('reports a stored value that is not JSON', async () => {
    const result = await readKvJson(storeWith({ k: '["a"' }), 'k', Tokens);
    expect(result?.ok).toBe(false);
  });

  test('reports a stored value that does not match the schema', async () => {
    const result = await readKvJson(storeWith({ k: '[1]' }), 'k', Tokens);
    expect(result?.ok).toBe(false);
  });
});
