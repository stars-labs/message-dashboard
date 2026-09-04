import { describe, expect, test } from 'bun:test';
import { listFilterRules, setupFilterRoutes } from './filters.js';

function dbStub() {
  const calls = [];

  return {
    calls,
    prepare(sql) {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          calls.push(sql);
          return {
            results: [{
              id: 1,
              rule_type: 'sender',
              pattern: '10655446',
              note: 'China Unicom marketing',
              is_active: 1,
            }],
          };
        },
        async first() {
          calls.push(sql);
          return { n: 2 };
        },
      };
      return statement;
    },
  };
}

describe('filter rule list D1 reads', () => {
  test('lists rule metadata without scanning messages for historical hit counts', async () => {
    const db = dbStub();

    const result = await listFilterRules(db);

    expect(result).toEqual({
      filters: [{
        id: 1,
        rule_type: 'sender',
        pattern: '10655446',
        note: 'China Unicom marketing',
        is_active: 1,
      }],
    });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).toContain('FROM filter_rules');
    expect(db.calls[0]).not.toMatch(/FROM messages|COUNT\s*\(/i);
    expect(db.calls.every((sql) => !sql.includes('filter_rule_id'))).toBe(true);
  });

  test('creating a rule does not read or write historical messages', async () => {
    const routes = [];
    setupFilterRoutes({
      get() {},
      put() {},
      delete() {},
      post(path, handler) { routes.push({ path, handler }); },
    });
    const calls = [];
    const db = {
      prepare(sql) {
        calls.push(sql);
        const statement = {
          bind() { return statement; },
          async first() {
            return { id: 7, rule_type: 'sender', pattern: '10655446', note: null, is_active: 1 };
          },
        };
        return statement;
      },
    };
    const env = {
      DB: db,
      SESSIONS: {
        async get() {
          return JSON.stringify({
            expires_at: Date.now() + 60_000,
            user: { sub: 'auth0|admin', roles: ['admin'] },
          });
        },
      },
    };
    const request = {
      url: 'https://example.com/api/filters',
      env,
      headers: { get: (name) => name === 'Cookie' ? 'auth_token=session' : null },
      async json() { return { rule_type: 'sender', pattern: '10655446' }; },
    };

    const route = routes.find(({ path }) => path === '/api/filters');
    const response = await route.handler(request, env, {});

    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('INSERT INTO filter_rules');
    expect(calls[0]).not.toContain('messages');
    expect(await response.json()).toEqual({
      filter: { id: 7, rule_type: 'sender', pattern: '10655446', note: null, is_active: 1 },
    });
  });

  test('toggling a rule changes only the rule row and keeps matching identity immutable', async () => {
    const routes = [];
    setupFilterRoutes({
      get() {},
      post() {},
      delete() {},
      put(path, handler) { routes.push({ path, handler }); },
    });
    const calls = [];
    const existing = { id: 7, rule_type: 'sender', pattern: '10655446', note: null, is_active: 1 };
    const db = {
      prepare(sql) {
        calls.push(sql);
        const statement = {
          bind() { return statement; },
          async first() {
            return sql.startsWith('SELECT') ? existing : { ...existing, is_active: 0 };
          },
        };
        return statement;
      },
    };
    const env = {
      DB: db,
      SESSIONS: {
        async get() {
          return JSON.stringify({
            expires_at: Date.now() + 60_000,
            user: { sub: 'auth0|admin', roles: ['admin'] },
          });
        },
      },
    };
    const route = routes.find(({ path }) => path === '/api/filters/:id');
    const request = {
      url: 'https://example.com/api/filters/7',
      env,
      params: { id: '7' },
      headers: { get: (name) => name === 'Cookie' ? 'auth_token=session' : null },
      async json() { return { is_active: false }; },
    };

    const response = await route.handler(request, env, {});

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls.every((sql) => !sql.includes('messages'))).toBe(true);

    calls.length = 0;
    request.json = async () => ({ pattern: '10086' });
    const immutableResponse = await route.handler(request, env, {});
    expect(immutableResponse.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
