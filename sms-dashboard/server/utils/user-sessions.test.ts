import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { indexSession, revokeUserSessions, unindexSession } from './user-sessions.js';

function kvStub(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

const env = (initial?: Record<string, string>) => {
  const sessions = kvStub(initial);
  return { SESSIONS: sessions, store: sessions.store };
};

function indexAt(store: Map<string, string>, key: string): unknown {
  const raw = store.get(key);
  if (raw === undefined) return undefined;
  const parsed = parseJson(raw, v.unknown());
  return parsed.ok ? parsed.value : undefined;
}

describe('indexSession', () => {
  test('records a token under the user', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a']);
  });

  test('accumulates multiple sessions for one user', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    await indexSession(e, 'auth0|1', 'tok-b');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a', 'tok-b']);
  });

  test('does not duplicate the same token', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    await indexSession(e, 'auth0|1', 'tok-a');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a']);
  });

  test('keeps users separate', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    await indexSession(e, 'auth0|2', 'tok-b');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a']);
    expect(indexAt(e.store, 'usess:auth0|2')).toEqual(['tok-b']);
  });

  test('ignores missing arguments rather than writing junk keys', async () => {
    const e = env();
    await indexSession(e, null, 'tok');
    await indexSession(e, 'auth0|1', null);
    expect(e.store.size).toBe(0);
  });

  test('drops non-string entries from a stored index', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a', 7, null]) });
    await indexSession(e, 'auth0|1', 'tok-b');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a', 'tok-b']);
  });

  test('treats an index that is not an array as empty', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify({ not: 'an array' }) });
    await indexSession(e, 'auth0|1', 'tok-a');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a']);
  });
});

describe('unindexSession', () => {
  test('removes only the given token', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a', 'tok-b']) });
    await unindexSession(e, 'auth0|1', 'tok-a');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-b']);
  });

  test('deletes the index entirely once empty', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a']) });
    await unindexSession(e, 'auth0|1', 'tok-a');
    expect(e.store.has('usess:auth0|1')).toBe(false);
  });

  test('is a no-op for an unknown token or user', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a']) });
    await unindexSession(e, 'auth0|1', 'nope');
    await unindexSession(e, 'auth0|other', 'tok-a');
    expect(indexAt(e.store, 'usess:auth0|1')).toEqual(['tok-a']);
  });
});

describe('revokeUserSessions', () => {
  test('deletes every session token and the index', async () => {
    const e = env({
      'usess:auth0|1': JSON.stringify(['tok-a', 'tok-b']),
      'tok-a': '{"user":{"id":"auth0|1"}}',
      'tok-b': '{"user":{"id":"auth0|1"}}',
    });

    expect(await revokeUserSessions(e, 'auth0|1')).toBe(2);
    expect(e.store.has('tok-a')).toBe(false);
    expect(e.store.has('tok-b')).toBe(false);
    expect(e.store.has('usess:auth0|1')).toBe(false);
  });

  test("leaves other users' sessions alone", async () => {
    const e = env({
      'usess:auth0|1': JSON.stringify(['tok-a']),
      'tok-a': 'x',
      'usess:auth0|2': JSON.stringify(['tok-b']),
      'tok-b': 'y',
    });

    await revokeUserSessions(e, 'auth0|1');
    expect(e.store.has('tok-b')).toBe(true);
    expect(e.store.has('usess:auth0|2')).toBe(true);
  });

  test('returns 0 for a user with no sessions', async () => {
    expect(await revokeUserSessions(env(), 'auth0|nobody')).toBe(0);
    expect(await revokeUserSessions(env(), null)).toBe(0);
  });

  test('tolerates a corrupt index without throwing', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify({ not: 'an array' }) });
    expect(await revokeUserSessions(e, 'auth0|1')).toBe(0);
  });

  test('fails loudly when the stored index is not JSON, so revocation never silently skips', async () => {
    const e = env({ 'usess:auth0|1': '["tok-a"' });
    let thrown: unknown;
    try {
      await revokeUserSessions(e, 'auth0|1');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
