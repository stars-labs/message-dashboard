import { describe, expect, test } from 'bun:test';

const handlerFiles = [
  './control.js',
  './health.js',
  '../api/keywords.js',
  './keywords.js',
];

describe('database schema ownership', () => {
  test('request handlers never create tables or indexes', async () => {
    for (const relativePath of handlerFiles) {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
      expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX)/i);
    }
  });
});
