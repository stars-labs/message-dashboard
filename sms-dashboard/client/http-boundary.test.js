import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

// Client HTTP has one path: lib/api.js. lib/auth.js is the only other caller,
// because its session probe must tell "signed out" (401) from "server failing"
// without fetchWithAuth's redirect-to-login on 401.
const ALLOWED = new Set(['lib/api.js', 'lib/auth.js']);

describe('client HTTP boundary', () => {
  test('only lib/api.js and lib/auth.js call fetch', async () => {
    const root = new URL('./', import.meta.url).pathname;
    const offenders = [];
    for await (const path of new Glob('**/*.{js,svelte}').scan(root)) {
      if (ALLOWED.has(path) || path.endsWith('.test.js')) continue;
      const source = await Bun.file(root + path).text();
      source.split('\n').forEach((line, index) => {
        if (/(?<![\w.$])fetch\(/.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
