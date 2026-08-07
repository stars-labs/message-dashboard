// Run with: bun test server/utils/user-sessions.test.js
import { describe, expect, test } from 'bun:test';
import { indexSession, revokeUserSessions, unindexSession } from './user-sessions.js';

function kvStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, options) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return options?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const env = (initial) => ({ SESSIONS: kvStub(initial) });

describe('indexSession', () => {
  test('records a token under the user', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|1'))).toEqual(['tok-a']);
  });

  test('accumulates multiple sessions for one user', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    await indexSession(e, 'auth0|1', 'tok-b');
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|1'))).toEqual(['tok-a', 'tok-b']);
  });

  test('does not duplicate the same token', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    await indexSession(e, 'auth0|1', 'tok-a');
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|1'))).toEqual(['tok-a']);
  });

  test('keeps users separate', async () => {
    const e = env();
    await indexSession(e, 'auth0|1', 'tok-a');
    await indexSession(e, 'auth0|2', 'tok-b');
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|1'))).toEqual(['tok-a']);
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|2'))).toEqual(['tok-b']);
  });

  test('ignores missing arguments rather than writing junk keys', async () => {
    const e = env();
    await indexSession(e, null, 'tok');
    await indexSession(e, 'auth0|1', null);
    expect(e.SESSIONS.store.size).toBe(0);
  });
});

describe('unindexSession', () => {
  test('removes only the given token', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a', 'tok-b']) });
    await unindexSession(e, 'auth0|1', 'tok-a');
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|1'))).toEqual(['tok-b']);
  });

  test('deletes the index entirely once empty', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a']) });
    await unindexSession(e, 'auth0|1', 'tok-a');
    expect(e.SESSIONS.store.has('usess:auth0|1')).toBe(false);
  });

  test('is a no-op for an unknown token or user', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify(['tok-a']) });
    await unindexSession(e, 'auth0|1', 'nope');
    await unindexSession(e, 'auth0|other', 'tok-a');
    expect(JSON.parse(e.SESSIONS.store.get('usess:auth0|1'))).toEqual(['tok-a']);
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
    expect(e.SESSIONS.store.has('tok-a')).toBe(false);
    expect(e.SESSIONS.store.has('tok-b')).toBe(false);
    expect(e.SESSIONS.store.has('usess:auth0|1')).toBe(false);
  });

  test('leaves other users\' sessions alone', async () => {
    const e = env({
      'usess:auth0|1': JSON.stringify(['tok-a']),
      'tok-a': 'x',
      'usess:auth0|2': JSON.stringify(['tok-b']),
      'tok-b': 'y',
    });

    await revokeUserSessions(e, 'auth0|1');
    expect(e.SESSIONS.store.has('tok-b')).toBe(true);
    expect(e.SESSIONS.store.has('usess:auth0|2')).toBe(true);
  });

  test('returns 0 for a user with no sessions', async () => {
    expect(await revokeUserSessions(env(), 'auth0|nobody')).toBe(0);
    expect(await revokeUserSessions(env(), null)).toBe(0);
  });

  test('tolerates a corrupt index without throwing', async () => {
    const e = env({ 'usess:auth0|1': JSON.stringify({ not: 'an array' }) });
    expect(await revokeUserSessions(e, 'auth0|1')).toBe(0);
  });
});
