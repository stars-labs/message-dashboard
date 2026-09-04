import { describe, expect, test } from 'bun:test';
import { setupKeywordRoutes } from './keywords.js';

function authenticatedEnv(db) {
  return {
    DB: db,
    SESSIONS: {
      async get() {
        return JSON.stringify({
          expires_at: Date.now() + 60_000,
          user: { id: 'auth0|admin', roles: ['admin'] },
        });
      },
    },
  };
}

function request(path, body, params = {}) {
  return {
    url: `https://example.com${path}`,
    params,
    headers: { get: (name) => name === 'Cookie' ? 'auth_token=session' : null },
    async json() { return body; },
  };
}

function collectRoutes() {
  const routes = [];
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (path, handler) => routes.push({ method, path, handler });
  }
  setupKeywordRoutes(router);
  return routes;
}

describe('keyword rule D1 reads', () => {
  test('creating a keyword never scans or writes historical messages', async () => {
    const calls = [];
    const keyword = {
      id: 7, keyword: 'code', tag: 'OTP', color: '#3B82F6', priority: 0,
      case_sensitive: 0, whole_word: 0, is_active: 1,
    };
    const db = {
      prepare(sql) {
        calls.push(sql);
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes('SELECT id FROM keyword_tags')) return null;
            if (sql.includes('SELECT * FROM keyword_tags')) return keyword;
            return null;
          },
          async run() { return { meta: { last_row_id: 7, changes: 1 } }; },
        };
        return statement;
      },
    };
    const env = authenticatedEnv(db);
    const route = collectRoutes().find(({ method, path }) => method === 'post' && path === '/api/keywords');
    const req = request('/api/keywords', {
      keyword: 'code', tag: 'OTP', color: '#3B82F6', priority: 0,
      case_sensitive: false, whole_word: false,
    });
    req.env = env;

    const response = await route.handler(req, env, {});

    expect(response.status).toBe(201);
    expect(calls).toHaveLength(3);
    expect(calls.every((sql) => !/FROM messages|message_tags/i.test(sql))).toBe(true);
  });

  test('updates metadata only and rejects changes to matching identity', async () => {
    const calls = [];
    const existing = {
      id: 7, keyword: 'code', tag: 'OTP', color: '#3B82F6', priority: 0,
      case_sensitive: 0, whole_word: 0, is_active: 1,
    };
    const db = {
      prepare(sql) {
        calls.push(sql);
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.trimStart().startsWith('SELECT')) return existing;
            return { ...existing, tag: 'Login' };
          },
        };
        return statement;
      },
    };
    const env = authenticatedEnv(db);
    const route = collectRoutes().find(({ method, path }) => method === 'put' && path === '/api/keywords/:id');
    const req = request('/api/keywords/7', { tag: 'Login' }, { id: '7' });
    req.env = env;

    const response = await route.handler(req, env, {});
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls.every((sql) => !/messages|message_tags/i.test(sql))).toBe(true);

    calls.length = 0;
    req.json = async () => ({ whole_word: true });
    const immutableResponse = await route.handler(req, env, {});
    expect(immutableResponse.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test('batch tag reads hide inactive keyword rules', async () => {
    let query = '';
    const db = {
      prepare(sql) {
        query = sql;
        const statement = {
          bind() { return statement; },
          async all() { return { results: [] }; },
        };
        return statement;
      },
    };
    const env = authenticatedEnv(db);
    const route = collectRoutes().find(({ method, path }) => method === 'post' && path === '/api/messages/batch-tags');
    const req = request('/api/messages/batch-tags', { messageIds: ['m-1'] });
    req.env = env;

    const response = await route.handler(req, env, {});
    expect(response.status).toBe(200);
    expect(query).toContain('kt.is_active = TRUE');
  });
});
