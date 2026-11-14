import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { CallState } from './call-state.js';

const call = { id: 'call-1', state: 'active', iccid: '8986000000000000001' };

const Snapshot = (body: unknown) =>
  v.parse(v.object({ call: v.unknown(), revision: v.string(), expiresAt: v.number() }), body);

function fleet(options: { legacy?: string | null } = {}) {
  const store = new Map<string, unknown>();
  const legacyReads: string[] = [];
  let settled: Promise<void> = Promise.resolve();
  const object = new CallState(
    {
      storage: {
        kv: {
          get: (key) => store.get(key),
          put: (key, value) => {
            store.set(key, value);
          },
          delete: (key) => {
            store.delete(key);
          },
        },
        transactionSync: (fn) => fn(),
      },
      blockConcurrencyWhile: (fn) => {
        settled = fn();
      },
    },
    {
      SESSIONS: {
        get: (key) => {
          legacyReads.push(key);
          return Promise.resolve(options.legacy ?? null);
        },
      },
    },
  );

  async function read() {
    await settled;
    return object.fetch(new Request('https://call-state/'));
  }

  async function change(body: unknown) {
    await settled;
    return object.fetch(
      new Request('https://call-state/', { method: 'POST', body: JSON.stringify(body) }),
    );
  }

  return { object, store, legacyReads, settled: () => settled, read, change };
}

describe('CallState', () => {
  test('holds no call until one is written', async () => {
    const { read } = fleet();
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  test('writes a call against no snapshot and returns its revision', async () => {
    const { read, change } = fleet();
    const before = Date.now();
    const written = await change({ call, expected: null, ttl: 60 });
    expect(written.status).toBe(200);
    const revision = v.parse(v.string(), await written.json());

    const snapshot = Snapshot(await (await read()).json());
    expect(snapshot.call).toEqual(call);
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(snapshot.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test('refuses a write whose expected revision is not the current one', async () => {
    const { read, change } = fleet();
    const revision = await (await change({ call, expected: null, ttl: 60 })).json();

    const stale = await change({ call: { ...call, state: 'ending' }, expected: 'stale', ttl: 60 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toBeNull();
    expect(await (await read()).json()).toMatchObject({ call, revision });

    const unconditional = await change({ call, expected: null, ttl: 60 });
    expect(unconditional.status).toBe(409);
  });

  test('refuses a write that names no expected revision', async () => {
    const { change } = fleet();
    const response = await change({ call, ttl: 60 });
    expect(response.status).toBe(409);
  });

  test('replaces the call and issues a new revision when the expected one matches', async () => {
    const { read, change } = fleet();
    const first = await (await change({ call, expected: null, ttl: 60 })).json();
    const next = { ...call, state: 'ending' };

    const second = await (await change({ call: next, expected: first, ttl: 60 })).json();

    expect(second).not.toBe(first);
    expect(await (await read()).json()).toMatchObject({ call: next, revision: second });
  });

  test('clears the call when the expected revision matches', async () => {
    const { read, change } = fleet();
    const revision = await (await change({ call, expected: null, ttl: 60 })).json();

    const cleared = await change({ call: null, expected: revision, ttl: 3600 });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toBeNull();
    expect(await (await read()).json()).toBeNull();
  });

  test('does not clear a call another request replaced', async () => {
    const { read, change } = fleet();
    const first = await (await change({ call, expected: null, ttl: 60 })).json();
    await change({ call, expected: first, ttl: 60 });

    const cleared = await change({ call: null, expected: first, ttl: 3600 });
    expect(cleared.status).toBe(409);
    expect(await (await read()).json()).not.toBeNull();
  });

  test('treats an expired call as absent', async () => {
    const { read, change } = fleet();
    await change({ call, expected: null, ttl: -1 });

    expect(await (await read()).json()).toBeNull();
    const replacement = await change({ call, expected: null, ttl: 60 });
    expect(replacement.status).toBe(200);
  });

  test('treats a stored snapshot that does not match the record schema as absent', async () => {
    const { read, change, store } = fleet();
    await read();
    store.set('call', { call, revision: 7, expiresAt: Date.now() + 60_000 });

    expect(await (await read()).json()).toBeNull();
    const replacement = await change({ call, expected: null, ttl: 60 });
    expect(replacement.status).toBe(200);
  });

  test('answers 400 when a change does not match the request schema', async () => {
    const { read, change } = fleet();
    for (const body of [null, 'call', { call, expected: 7, ttl: 60 }, { call, expected: null }]) {
      const response = await change(body);
      expect(response.status).toBe(400);
    }
    expect(await (await read()).json()).toBeNull();
  });

  test('answers 400 when the change is not JSON', async () => {
    const { object, settled } = fleet();
    await settled();
    const response = await object.fetch(
      new Request('https://call-state/', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('CallState migration from the session store', () => {
  test('adopts a legacy ringing call for a minute', async () => {
    const legacy = { id: 'legacy', state: 'ringing' };
    const { read, legacyReads } = fleet({ legacy: JSON.stringify(legacy) });
    const before = Date.now();

    const snapshot = Snapshot(await (await read()).json());

    expect(legacyReads).toEqual(['voice:active-call']);
    expect(snapshot).toMatchObject({ call: legacy });
    expect(snapshot.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(snapshot.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test('adopts any other legacy call for an hour', async () => {
    const legacy = { id: 'legacy', state: 'active' };
    const { read } = fleet({ legacy: JSON.stringify(legacy) });
    const before = Date.now();

    const snapshot = Snapshot(await (await read()).json());

    expect(snapshot).toMatchObject({ call: legacy });
    expect(snapshot.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(snapshot.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  test('keeps no call when the session store has none', async () => {
    const { read, store } = fleet();
    expect(await (await read()).json()).toBeNull();
    expect(store.get('initialized')).toBe(true);
  });

  test('migrates once', async () => {
    const first = fleet({ legacy: JSON.stringify({ id: 'legacy', state: 'active' }) });
    await first.settled();
    expect(first.store.get('initialized')).toBe(true);

    const reads: string[] = [];
    let settled: Promise<void> = Promise.resolve();
    new CallState(
      {
        storage: {
          kv: {
            get: (key) => first.store.get(key),
            put: (key, value) => {
              first.store.set(key, value);
            },
            delete: (key) => {
              first.store.delete(key);
            },
          },
          transactionSync: (fn) => fn(),
        },
        blockConcurrencyWhile: (fn) => {
          settled = fn();
        },
      },
      {
        SESSIONS: {
          get: (key) => {
            reads.push(key);
            return Promise.resolve(null);
          },
        },
      },
    );
    await settled;

    expect(reads).toEqual([]);
  });

  test('refuses to start on a legacy value that is not a call', async () => {
    for (const legacy of ['not json', 'null']) {
      const { settled } = fleet({ legacy });
      let failure: unknown;
      try {
        await settled();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
    }
  });
});
