import { describe, expect, test } from 'bun:test';
import { secretMatches } from './secret.js';

describe('secretMatches', () => {
  test('accepts the exact secret', async () => {
    expect(await secretMatches('s3cret-key', 's3cret-key')).toBe(true);
  });

  test('rejects a different secret of the same length', async () => {
    expect(await secretMatches('s3cret-kez', 's3cret-key')).toBe(false);
  });

  test('rejects a prefix or an extension of the secret', async () => {
    expect(await secretMatches('s3cret', 's3cret-key')).toBe(false);
    expect(await secretMatches('s3cret-key!', 's3cret-key')).toBe(false);
  });

  test('rejects when nothing is presented or nothing is configured', async () => {
    expect(await secretMatches(null, 's3cret-key')).toBe(false);
    expect(await secretMatches('', 's3cret-key')).toBe(false);
    expect(await secretMatches('s3cret-key', undefined)).toBe(false);
    expect(await secretMatches('', '')).toBe(false);
  });
});
