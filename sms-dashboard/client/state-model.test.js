import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

// Client state uses Svelte 5 runes only; svelte/store is the legacy model.
describe('client state model', () => {
  test('nothing imports svelte/store', async () => {
    const root = new URL('./', import.meta.url).pathname;
    const offenders = [];
    for await (const path of new Glob('**/*.{js,svelte}').scan(root)) {
      if (path.endsWith('.test.js')) continue;
      const source = await Bun.file(root + path).text();
      if (/from\s+['"]svelte\/store['"]/.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
