import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { memoryKv } from '../../test/memory-kv.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { createSchema } from '../../test/schema.js';
import { callWorker } from '../../test/worker-harness.js';
import type { D1, D1Batch, D1Statement } from '../lib/d1.js';
import { resolveServiceType, resolveSimRole } from './iccid-mappings.js';

let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

async function createMigratedDatabase() {
  const database = new Database(':memory:');
  await createSchema(database);
  return database;
}

const OPERATOR = 'operator@example.com';
const ADMIN = 'session-admin';
const VIEWER = 'session-viewer';
const NO_EMAIL = 'session-no-email';

function session(email: string, roles: string[]): string {
  return JSON.stringify({
    user: { id: 'auth0|operator', email, roles },
    expires_at: Date.now() + 3_600_000,
  });
}

const SESSIONS = memoryKv({
  [ADMIN]: session(OPERATOR, ['sms-admin']),
  [VIEWER]: session(OPERATOR, ['sms-viewer']),
  [NO_EMAIL]: session('', ['sms-admin']),
});

async function call(
  DB: D1 & D1Batch,
  method: string,
  path: string,
  { body, token = ADMIN }: { body?: unknown; token?: string } = {},
): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const { response } = await callWorker(method, path, {
    headers: {
      Cookie: `auth_token=${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: text }),
    bindings: { DB, SESSIONS },
  });
  return response;
}

function insertSim(
  database: Database,
  iccid: string,
  index: number,
  overrides: { carrier?: string; notes?: string } = {},
) {
  database
    .query(
      `INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier, notes)
       VALUES (?, ?, ?, 'SG', ?, ?)`,
    )
    .run(
      iccid,
      index,
      `+65000000${String(index).padStart(2, '0')}`,
      overrides.carrier ?? 'Singtel',
      overrides.notes ?? null,
    );
}

function failingDb(): D1 & D1Batch {
  return {
    prepare() {
      throw new Error('D1 is down');
    },
    batch() {
      throw new Error('D1 is down');
    },
  };
}

function rowsDb(row: unknown): D1 & D1Batch {
  function statement(): D1Statement {
    return {
      bind: statement,
      all: () => Promise.resolve({ results: [row] }),
      first: () => Promise.resolve(row),
      run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
    };
  }
  return { prepare: statement, batch: () => Promise.resolve([]) };
}

const NumberRow = v.object({ n: v.number() });

function count(database: Database, sql: string): number {
  return v.parse(NumberRow, database.query(sql).get()).n;
}

const Problem = v.looseObject({
  type: v.string(),
  title: v.string(),
  status: v.number(),
  detail: v.string(),
  code: v.string(),
});
const DataBody = v.looseObject({ data: v.record(v.string(), v.unknown()) });
const ListBody = v.object({
  success: v.literal(true),
  data: v.array(v.looseObject({ iccid: v.string() })),
  pagination: v.object({
    page: v.number(),
    limit: v.number(),
    total: v.number(),
    totalPages: v.number(),
  }),
});
const BulkBody = v.object({
  success: v.literal(true),
  summary: v.object({
    total: v.number(),
    created: v.number(),
    updated: v.number(),
    failed: v.number(),
  }),
  errors: v.optional(v.array(v.string())),
});

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return v.parse(Problem, await response.json());
}

async function dataOf(response: Response) {
  return v.parse(DataBody, await response.json()).data;
}

describe('SIM service type validation', () => {
  test('defaults new SIMs to unknown without verification metadata', () => {
    expect(resolveServiceType({})).toEqual({
      serviceType: 'unknown',
      serviceTypeSource: null,
      serviceTypeProvided: false,
    });
  });

  test('requires a controlled source for a confirmed type', () => {
    expect(resolveServiceType({ service_type: 'prepaid' })).toEqual({
      error: 'A valid service_type_source is required for prepaid or postpaid SIMs',
    });
    expect(
      resolveServiceType({
        service_type: 'postpaid',
        service_type_source: 'contract_or_bill',
      }),
    ).toEqual({
      serviceType: 'postpaid',
      serviceTypeSource: 'contract_or_bill',
      serviceTypeProvided: true,
    });
  });

  test('rejects a source outside the controlled list', () => {
    expect(resolveServiceType({ service_type: 'prepaid', service_type_source: 'guess' })).toEqual({
      error: 'A valid service_type_source is required for prepaid or postpaid SIMs',
    });
  });

  test('preserves an existing confirmation when an update omits the fields', () => {
    expect(
      resolveServiceType(
        {},
        {
          service_type: 'prepaid',
          service_type_source: 'carrier_account',
        },
      ),
    ).toEqual({
      serviceType: 'prepaid',
      serviceTypeSource: 'carrier_account',
      serviceTypeProvided: false,
    });
  });

  test('clears source metadata when explicitly reset to unknown', () => {
    expect(
      resolveServiceType({
        service_type: 'unknown',
        service_type_source: 'carrier_message',
      }),
    ).toEqual({
      serviceType: 'unknown',
      serviceTypeSource: null,
      serviceTypeProvided: true,
    });
  });

  test('an empty or null service_type resets to unknown instead of keeping the existing one', () => {
    const existing = { service_type: 'prepaid', service_type_source: 'carrier_account' };
    for (const serviceType of ['', null]) {
      expect(resolveServiceType({ service_type: serviceType }, existing)).toEqual({
        serviceType: 'unknown',
        serviceTypeSource: null,
        serviceTypeProvided: true,
      });
    }
  });

  test('accepts balance-managed SIMs without verification metadata', () => {
    expect(
      resolveServiceType({
        service_type: 'balance_managed',
        service_type_source: 'carrier_message',
      }),
    ).toEqual({
      serviceType: 'balance_managed',
      serviceTypeSource: null,
      serviceTypeProvided: true,
    });
  });

  test('rejects the replaced n/a service type', () => {
    expect(resolveServiceType({ service_type: 'n/a' })).toEqual({
      error: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });
  });

  test('rejects unsupported inferred categories', () => {
    expect(resolveServiceType({ service_type: 'hybrid' })).toEqual({
      error: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });
  });

  test('persists and clears manual confirmation through the real migrated schema', async () => {
    const database = await createMigratedDatabase();
    const d1 = sqliteD1(database);

    const createResponse = await call(d1, 'POST', '/api/iccid-mappings', {
      body: {
        iccid: 'test-iccid',
        sim_index: 1,
        phone_number: '+6500000000',
        country_code: 'SG',
        carrier: 'Test Carrier',
        service_type: 'postpaid',
        service_type_source: 'contract_or_bill',
      },
    });
    expect(createResponse.status).toBe(201);

    const confirmed = v.parse(
      v.object({
        service_type: v.string(),
        service_type_source: v.string(),
        service_type_verified_at: v.string(),
        updated_by: v.string(),
      }),
      database
        .query(
          `
      SELECT service_type, service_type_source, service_type_verified_at, updated_by
      FROM sims WHERE iccid = 'test-iccid'
    `,
        )
        .get(),
    );
    expect(confirmed.service_type).toBe('postpaid');
    expect(confirmed.service_type_source).toBe('contract_or_bill');
    expect(confirmed.service_type_verified_at).not.toBe('');
    expect(confirmed.updated_by).toBe(OPERATOR);

    const updateResponse = await call(d1, 'PUT', '/api/iccid-mappings/test-iccid', {
      body: {
        phone_number: '+6500000000',
        sim_index: 1,
        country_code: 'SG',
        carrier: 'Test Carrier',
        service_type: 'unknown',
        service_type_source: null,
      },
    });
    expect(updateResponse.status).toBe(200);

    const reset = database
      .query(
        `
      SELECT service_type, service_type_source, service_type_verified_at
      FROM sims WHERE iccid = 'test-iccid'
    `,
      )
      .get();
    expect(reset).toEqual({
      service_type: 'unknown',
      service_type_source: null,
      service_type_verified_at: null,
    });
    expect(() =>
      database
        .query(
          `
      UPDATE sims
      SET service_type = 'postpaid',
          service_type_source = NULL,
          service_type_verified_at = NULL
      WHERE iccid = 'test-iccid'
    `,
        )
        .run(),
    ).toThrow('invalid SIM service type verification metadata');
    database.close();
  });
});

describe('SIM primary/secondary role validation', () => {
  function roleDatabase() {
    const database = new Database(':memory:');
    database.run(`CREATE TABLE sims (iccid TEXT PRIMARY KEY, sim_role TEXT, primary_iccid TEXT)`);
    return database;
  }

  test('defaults to standalone with no primary_iccid', async () => {
    const database = roleDatabase();
    const env = { DB: sqliteD1(database) };
    expect(await resolveSimRole({}, null, env)).toEqual({
      role: 'standalone',
      primaryIccid: null,
      roleProvided: false,
    });
    database.close();
  });

  test('rejects an invalid role', async () => {
    const database = roleDatabase();
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole({ sim_role: 'backup' }, null, env);
    expect(result).toEqual({ error: 'sim_role must be standalone, primary, or secondary' });
    database.close();
  });

  test('an empty sim_role resets to standalone instead of keeping the existing role', async () => {
    const database = roleDatabase();
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole(
      { sim_role: '' },
      { sim_role: 'primary', primary_iccid: null },
      env,
    );
    expect(result).toEqual({ role: 'standalone', primaryIccid: null, roleProvided: true });
    database.close();
  });

  test('secondary without primary_iccid is rejected', async () => {
    const database = roleDatabase();
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole({ sim_role: 'secondary' }, null, env);
    expect(result).toEqual({ error: 'primary_iccid is required for a secondary SIM' });
    database.close();
  });

  test('secondary pointing at a non-existent SIM is rejected', async () => {
    const database = roleDatabase();
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole(
      {
        sim_role: 'secondary',
        primary_iccid: 'missing-iccid',
      },
      null,
      env,
    );
    expect(result).toEqual({ error: 'primary_iccid does not match any SIM' });
    database.close();
  });

  test('secondary pointing at a standalone SIM is rejected', async () => {
    const database = roleDatabase();
    database.run(
      `INSERT INTO sims (iccid, sim_role, primary_iccid) VALUES ('solo', 'standalone', NULL)`,
    );
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole(
      {
        sim_role: 'secondary',
        primary_iccid: 'solo',
      },
      null,
      env,
    );
    expect(result).toEqual({ error: 'primary_iccid points to a standalone SIM, not a primary' });
    database.close();
  });

  test('secondary pointing at a real primary succeeds', async () => {
    const database = roleDatabase();
    database.run(
      `INSERT INTO sims (iccid, sim_role, primary_iccid) VALUES ('main', 'primary', NULL)`,
    );
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole(
      {
        sim_role: 'secondary',
        primary_iccid: 'main',
      },
      null,
      env,
    );
    expect(result).toEqual({
      role: 'secondary',
      primaryIccid: 'main',
      roleProvided: true,
    });
    database.close();
  });

  test('an existing secondary keeps its primary when the update omits the role fields', async () => {
    const database = roleDatabase();
    database.run(
      `INSERT INTO sims (iccid, sim_role, primary_iccid) VALUES ('main', 'primary', NULL)`,
    );
    const env = { DB: sqliteD1(database) };
    const result = await resolveSimRole({}, { sim_role: 'secondary', primary_iccid: 'main' }, env);
    expect(result).toEqual({ role: 'secondary', primaryIccid: 'main', roleProvided: false });
    database.close();
  });

  test('SQL trigger refuses secondary with NULL primary_iccid on insert', async () => {
    const database = await createMigratedDatabase();
    expect(() =>
      database.run(
        `INSERT INTO sims (iccid, sim_index, phone_number, sim_role) VALUES ('x', 1, 'n', 'secondary')`,
      ),
    ).toThrow('secondary SIM requires primary_iccid');
    database.close();
  });

  test('SQL trigger refuses primary with a primary_iccid set', async () => {
    const database = await createMigratedDatabase();
    expect(() =>
      database.run(
        `INSERT INTO sims (iccid, sim_index, phone_number, sim_role, primary_iccid) VALUES ('p', 1, 'n', 'primary', 'whatever')`,
      ),
    ).toThrow('secondary SIM requires primary_iccid');
    database.close();
  });

  test('ON DELETE RESTRICT blocks deleting a primary with secondaries attached', async () => {
    const database = await createMigratedDatabase();
    database.run(
      `INSERT INTO sims (iccid, sim_index, phone_number, sim_role, primary_iccid) VALUES ('main', 1, 'n', 'primary', NULL)`,
    );
    database.run(
      `INSERT INTO sims (iccid, sim_index, phone_number, sim_role, primary_iccid) VALUES ('sec', 2, 'n2', 'secondary', 'main')`,
    );
    expect(() => database.run(`DELETE FROM sims WHERE iccid = 'main'`)).toThrow(
      'FOREIGN KEY constraint failed',
    );
    database.close();
  });

  test('full create+update lifecycle through the API', async () => {
    const database = await createMigratedDatabase();
    const d1 = sqliteD1(database);

    const primaryResp = await call(d1, 'POST', '/api/iccid-mappings', {
      body: { iccid: 'primary-1', sim_index: 1, phone_number: '+861', sim_role: 'primary' },
    });
    expect(primaryResp.status).toBe(201);

    const secResp = await call(d1, 'POST', '/api/iccid-mappings', {
      body: {
        iccid: 'secondary-1',
        sim_index: 2,
        phone_number: '+862',
        sim_role: 'secondary',
        primary_iccid: 'primary-1',
      },
    });
    expect(secResp.status).toBe(201);

    const sec = database
      .query(`SELECT sim_role, primary_iccid FROM sims WHERE iccid = 'secondary-1'`)
      .get();
    expect(sec).toEqual({ sim_role: 'secondary', primary_iccid: 'primary-1' });

    const updateResp = await call(d1, 'PUT', '/api/iccid-mappings/secondary-1', {
      body: { phone_number: '+862', sim_index: 2, sim_role: 'standalone' },
    });
    expect(updateResp.status).toBe(200);
    const cleared = database
      .query(`SELECT sim_role, primary_iccid FROM sims WHERE iccid = 'secondary-1'`)
      .get();
    expect(cleared).toEqual({ sim_role: 'standalone', primary_iccid: null });

    const delResp = await call(d1, 'DELETE', '/api/iccid-mappings/primary-1');
    expect(delResp.status).toBe(200);
    database.close();
  });

  test('delete returns 409 when secondaries are still attached', async () => {
    const database = await createMigratedDatabase();
    const d1 = sqliteD1(database);

    await call(d1, 'POST', '/api/iccid-mappings', {
      body: { iccid: 'p', sim_index: 1, phone_number: 'n', sim_role: 'primary' },
    });
    await call(d1, 'POST', '/api/iccid-mappings', {
      body: {
        iccid: 's',
        sim_index: 2,
        phone_number: 'n2',
        sim_role: 'secondary',
        primary_iccid: 'p',
      },
    });

    const delResp = await call(d1, 'DELETE', '/api/iccid-mappings/p');
    expect(delResp.status).toBe(409);
    const problem = await problemOf(delResp);
    expect(problem.code).toBe('CONFLICT');
    expect(problem.detail).toMatch(/primary SIM with secondary/);
    database.close();
  });
});

describe('ICCID mapping authorization', () => {
  const guarded: { method: string; path: string; body?: unknown; viewerAllowed: boolean }[] = [
    { method: 'GET', path: '/api/iccid-mappings', viewerAllowed: true },
    { method: 'GET', path: '/api/iccid-mappings/iccid-a', viewerAllowed: true },
    { method: 'GET', path: '/api/iccid-mappings/by-iccid/iccid-a', viewerAllowed: true },
    {
      method: 'POST',
      path: '/api/iccid-mappings',
      body: { iccid: 'x', phone_number: '+1', sim_index: 5 },
      viewerAllowed: false,
    },
    {
      method: 'PUT',
      path: '/api/iccid-mappings/iccid-a',
      body: { phone_number: '+1', sim_index: 5 },
      viewerAllowed: false,
    },
    { method: 'DELETE', path: '/api/iccid-mappings/iccid-a', viewerAllowed: false },
    {
      method: 'POST',
      path: '/api/iccid-mappings/bulk',
      body: { mappings: [] },
      viewerAllowed: false,
    },
  ];

  for (const { method, path, body, viewerAllowed } of guarded) {
    test(`${method} ${path} answers 401 without a credential the middleware accepts`, async () => {
      const database = await createMigratedDatabase();
      insertSim(database, 'iccid-a', 1);

      const response = await call(sqliteD1(database), method, path, { body, token: 'unknown' });

      expect(response.status).toBe(401);
      database.close();
    });

    if (!viewerAllowed) {
      test(`${method} ${path} answers 403 to a role without the permission`, async () => {
        const database = await createMigratedDatabase();
        insertSim(database, 'iccid-a', 1);

        const response = await call(sqliteD1(database), method, path, { body, token: VIEWER });

        expect(response.status).toBe(403);
        expect(count(database, `SELECT COUNT(*) AS n FROM sims`)).toBe(1);
        database.close();
      });
    }
  }

  test('a viewer may read the list', async () => {
    const database = await createMigratedDatabase();

    const response = await call(sqliteD1(database), 'GET', '/api/iccid-mappings', {
      token: VIEWER,
    });

    expect(response.status).toBe(200);
    database.close();
  });
});

describe('ICCID mapping reads', () => {
  async function seeded() {
    const database = await createMigratedDatabase();
    insertSim(database, 'iccid-b', 2, { carrier: 'M1', notes: 'second desk' });
    insertSim(database, 'iccid-a', 1);
    insertSim(database, 'iccid-c', 3, { carrier: 'Singtel' });
    return { database, d1: sqliteD1(database) };
  }

  test('lists mappings by sim_index with the device_view columns and pagination', async () => {
    const { database, d1 } = await seeded();

    const response = await call(d1, 'GET', '/api/iccid-mappings');
    const body = v.parse(ListBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(body.data.map((row) => row.iccid)).toEqual(['iccid-a', 'iccid-b', 'iccid-c']);
    expect(body.data[1]).toMatchObject({
      id: 'iccid-b',
      iccid: 'iccid-b',
      sim_index: 2,
      phone_number: '+6500000002',
      country: 'SG',
      carrier: 'M1',
      service_type: 'unknown',
      service_type_source: null,
      service_type_verified_at: null,
      sim_role: 'standalone',
      primary_iccid: null,
      balance_threshold: null,
      equipment_id: null,
      notes: 'second desk',
      is_active: 'unassigned',
      signal_quality: null,
      modem_status: null,
      detected_iccid: null,
      operator: null,
      usb_path: null,
      last_usb_path: null,
    });
    expect(typeof body.data[1]?.['created_at']).toBe('string');
    expect(typeof body.data[1]?.['updated_at']).toBe('string');
    database.close();
  });

  test('filters by search text and pages the result', async () => {
    const { database, d1 } = await seeded();

    const searched = await call(d1, 'GET', '/api/iccid-mappings?search=Singtel');
    const searchedBody = v.parse(ListBody, await searched.json());
    expect(searchedBody.data.map((row) => row.iccid)).toEqual(['iccid-a', 'iccid-c']);
    expect(searchedBody.pagination.total).toBe(2);

    const paged = await call(d1, 'GET', '/api/iccid-mappings?page=2&limit=2');
    const pagedBody = v.parse(ListBody, await paged.json());
    expect(pagedBody.data.map((row) => row.iccid)).toEqual(['iccid-c']);
    expect(pagedBody.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    database.close();
  });

  test('list answers 400 for a page or limit that is not a positive integer', async () => {
    const { database, d1 } = await seeded();

    for (const query of ['page=abc', 'page=0', 'page=-1', 'page=1.5', 'limit=abc', 'limit=0']) {
      const response = await call(d1, 'GET', `/api/iccid-mappings?${query}`);
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'page and limit must be positive integers',
      });
    }
    database.close();
  });

  test('list answers 500 with the error detail when the database fails', async () => {
    const response = await call(failingDb(), 'GET', '/api/iccid-mappings');

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to fetch ICCID mappings: D1 is down',
    });
  });

  test('list answers 500 when a row does not match the schema', async () => {
    const response = await call(rowsDb({ iccid: 5 }), 'GET', '/api/iccid-mappings');

    expect(response.status).toBe(500);
    expect((await problemOf(response)).detail).toStartWith('Failed to fetch ICCID mappings');
  });

  test('get and getByIccid return one mapping or 404', async () => {
    const { database, d1 } = await seeded();

    const found = await call(d1, 'GET', '/api/iccid-mappings/iccid-a');
    expect(found.status).toBe(200);
    expect(await dataOf(found)).toMatchObject({ iccid: 'iccid-a', sim_index: 1 });

    const byIccid = await call(d1, 'GET', '/api/iccid-mappings/by-iccid/iccid-c');
    expect(byIccid.status).toBe(200);
    expect(await dataOf(byIccid)).toMatchObject({ iccid: 'iccid-c', sim_index: 3 });

    const missing = await call(d1, 'GET', '/api/iccid-mappings/nope');
    expect(missing.status).toBe(404);
    expect(await problemOf(missing)).toMatchObject({
      code: 'NOT_FOUND',
      detail: 'ICCID mapping not found',
    });

    const missingByIccid = await call(d1, 'GET', '/api/iccid-mappings/by-iccid/nope');
    expect(missingByIccid.status).toBe(404);
    expect(await problemOf(missingByIccid)).toMatchObject({
      code: 'NOT_FOUND',
      detail: 'ICCID not found',
    });
    database.close();
  });

  test('get and getByIccid answer 500 when the database fails or a row has the wrong shape', async () => {
    for (const db of [failingDb(), rowsDb({ iccid: 5 })]) {
      const get = await call(db, 'GET', '/api/iccid-mappings/a');
      expect(get.status).toBe(500);
      expect(await problemOf(get)).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        detail: 'Failed to fetch ICCID mapping',
      });

      const byIccid = await call(db, 'GET', '/api/iccid-mappings/by-iccid/a');
      expect(byIccid.status).toBe(500);
      expect(await problemOf(byIccid)).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        detail: 'Failed to fetch ICCID mapping',
      });
    }
  });
});

describe('ICCID mapping writes', () => {
  async function seeded() {
    const database = await createMigratedDatabase();
    insertSim(database, 'iccid-a', 1);
    return { database, d1: sqliteD1(database) };
  }

  const create = (d1: D1 & D1Batch, body: unknown) =>
    call(d1, 'POST', '/api/iccid-mappings', { body });
  const update = (d1: D1 & D1Batch, body: unknown, id = 'iccid-a') =>
    call(d1, 'PUT', `/api/iccid-mappings/${id}`, { body });

  test('create without iccid, phone_number or sim_index answers 400', async () => {
    const { database, d1 } = await seeded();

    for (const body of [
      { phone_number: '+1', sim_index: 5 },
      { iccid: 'x', sim_index: 5 },
      { iccid: 'x', phone_number: '+1' },
      { iccid: 'x', phone_number: '+1', sim_index: 0 },
    ]) {
      const response = await create(d1, body);
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'ICCID, phone number, and sim_index are required',
      });
    }
    database.close();
  });

  test('create answers 400 with the resolver message for a bad service type or role', async () => {
    const { database, d1 } = await seeded();
    const base = { iccid: 'x', phone_number: '+1', sim_index: 5 };

    const serviceType = await create(d1, { ...base, service_type: 'hybrid' });
    expect(serviceType.status).toBe(400);
    expect(await problemOf(serviceType)).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });

    const role = await create(d1, { ...base, sim_role: 'backup' });
    expect(role.status).toBe(400);
    expect(await problemOf(role)).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'sim_role must be standalone, primary, or secondary',
    });
    database.close();
  });

  test('create inserts with 201 and returns the stored mapping; a repeat updates with 200', async () => {
    const { database, d1 } = await seeded();
    const payload = {
      iccid: 'iccid-new',
      phone_number: '+6599999999',
      sim_index: 7,
      country_code: 'SG',
      carrier: 'StarHub',
      notes: 'front desk',
      balance_threshold: 12.5,
    };

    const created = await create(d1, payload);
    expect(created.status).toBe(201);
    expect(await dataOf(created)).toMatchObject({
      iccid: 'iccid-new',
      sim_index: 7,
      phone_number: '+6599999999',
      country_code: 'SG',
      carrier: 'StarHub',
      imei: null,
      notes: 'front desk',
      service_type: 'unknown',
      sim_role: 'standalone',
      balance_threshold: 12.5,
      status: 'unassigned',
    });

    const repeated = await create(d1, { ...payload, carrier: 'M1', notes: '' });
    expect(repeated.status).toBe(200);
    expect(await dataOf(repeated)).toMatchObject({ carrier: 'M1', notes: null });
    expect(count(database, `SELECT COUNT(*) AS n FROM sims`)).toBe(2);
    database.close();
  });

  test('create stores a numeric threshold and no threshold for null or an omitted one', async () => {
    const { database, d1 } = await seeded();
    const base = { phone_number: '+1', sim_index: 5 };

    for (const [iccid, extra] of [
      ['with', { balance_threshold: 8 }],
      ['null', { balance_threshold: null }],
      ['omitted', {}],
    ] as const) {
      const response = await create(d1, { ...base, iccid, ...extra });
      expect(response.status).toBe(201);
    }

    const thresholds = database
      .query(
        `SELECT iccid, balance_threshold FROM sims WHERE iccid IN ('with', 'null', 'omitted') ORDER BY iccid`,
      )
      .all();
    expect(thresholds).toEqual([
      { iccid: 'null', balance_threshold: null },
      { iccid: 'omitted', balance_threshold: null },
      { iccid: 'with', balance_threshold: 8 },
    ]);
    database.close();
  });

  test('create answers 400 and stores nothing for a threshold that is not a number', async () => {
    const { database, d1 } = await seeded();
    const base = { phone_number: '+1', sim_index: 5 };

    for (const balanceThreshold of ['8', 'abc', '']) {
      const response = await create(d1, {
        ...base,
        iccid: 'text',
        balance_threshold: balanceThreshold,
      });
      expect(response.status).toBe(400);
    }
    expect(count(database, `SELECT COUNT(*) AS n FROM sims WHERE iccid = 'text'`)).toBe(0);
    database.close();
  });

  test('create answers 400 for a body that is not JSON or has fields of the wrong type', async () => {
    const { database, d1 } = await seeded();
    const base = { iccid: 'x', phone_number: '+1', sim_index: 5 };

    const notJson = await create(d1, 'not json');
    expect(notJson.status).toBe(400);
    expect((await problemOf(notJson)).code).toBe('BAD_REQUEST');

    for (const body of [
      null,
      [],
      { ...base, iccid: 7 },
      { ...base, phone_number: 7 },
      { ...base, sim_index: '5' },
      { ...base, sim_index: 1.5 },
    ]) {
      const response = await create(d1, JSON.stringify(body));
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'ICCID, phone number, and sim_index are required',
      });
    }
    for (const body of [
      { ...base, carrier: 7 },
      { ...base, notes: { text: 'x' } },
      { ...base, service_type: 7 },
      { ...base, sim_role: 7 },
    ]) {
      const response = await create(d1, JSON.stringify(body));
      expect(response.status).toBe(400);
      expect((await problemOf(response)).code).toBe('BAD_REQUEST');
    }
    expect(count(database, `SELECT COUNT(*) AS n FROM sims WHERE iccid = 'x'`)).toBe(0);
    database.close();
  });

  test('create answers 500 with the error detail when the database fails', async () => {
    const response = await create(failingDb(), { iccid: 'x', phone_number: '+1', sim_index: 5 });

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to create ICCID mapping: D1 is down',
    });
  });

  // An absent field keeps what the SIM has; only a field that is sent changes it.
  test('update keeps the confirmed service type and role when the body omits them', async () => {
    const { database, d1 } = await seeded();
    database.run(
      `UPDATE sims SET service_type = 'prepaid', service_type_source = 'carrier_account',
         service_type_verified_at = CURRENT_TIMESTAMP
       WHERE iccid = 'iccid-a'`,
    );

    const response = await update(d1, { phone_number: '+6500000001', sim_index: 1 });

    expect(response.status).toBe(200);
    expect(
      database
        .query(
          `SELECT service_type, service_type_source, sim_role FROM sims WHERE iccid = 'iccid-a'`,
        )
        .get(),
    ).toEqual({
      service_type: 'prepaid',
      service_type_source: 'carrier_account',
      sim_role: 'standalone',
    });
    database.close();
  });

  test('update answers 404 for an unknown SIM', async () => {
    const { database, d1 } = await seeded();

    const response = await update(d1, { phone_number: '+1', sim_index: 5 }, 'nope');

    expect(response.status).toBe(404);
    expect(await problemOf(response)).toMatchObject({
      code: 'NOT_FOUND',
      detail: 'ICCID mapping not found',
    });
    database.close();
  });

  test('update answers 400 with the resolver message for a bad service type', async () => {
    const { database, d1 } = await seeded();

    const response = await update(d1, { phone_number: '+1', sim_index: 5, service_type: 'n/a' });

    expect(response.status).toBe(400);
    expect(await problemOf(response)).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });
    database.close();
  });

  test('update answers 400 for a body that is not JSON or lacks phone_number and sim_index', async () => {
    const { database, d1 } = await seeded();

    const notJson = await update(d1, 'not json');
    expect(notJson.status).toBe(400);
    expect((await problemOf(notJson)).code).toBe('BAD_REQUEST');

    for (const body of [
      { sim_index: 1 },
      { phone_number: '+1' },
      { phone_number: '', sim_index: 1 },
      { phone_number: '+1', sim_index: 0 },
    ]) {
      const response = await update(d1, body);
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'phone_number and sim_index are required',
      });
    }
    for (const body of [
      { phone_number: '+1', sim_index: 1, carrier: 7 },
      { phone_number: '+1', sim_index: 1, balance_threshold: 'abc' },
    ]) {
      const response = await update(d1, body);
      expect(response.status).toBe(400);
      expect((await problemOf(response)).code).toBe('BAD_REQUEST');
    }
    expect(database.query(`SELECT phone_number FROM sims WHERE iccid = 'iccid-a'`).get()).toEqual({
      phone_number: '+6500000001',
    });
    database.close();
  });

  test('update rewrites the row, returns the detail, and attributes it to the user', async () => {
    const { database, d1 } = await seeded();

    const response = await update(d1, {
      phone_number: '+6588888888',
      sim_index: 9,
      carrier: 'M1',
      notes: 'moved',
      balance_threshold: 20,
    });

    expect(response.status).toBe(200);
    expect(await dataOf(response)).toMatchObject({
      iccid: 'iccid-a',
      sim_index: 9,
      phone_number: '+6588888888',
      carrier: 'M1',
      country: null,
      notes: 'moved',
    });
    expect(
      database
        .query(`SELECT balance_threshold, updated_by FROM sims WHERE iccid = 'iccid-a'`)
        .get(),
    ).toEqual({ balance_threshold: 20, updated_by: OPERATOR });
    database.close();
  });

  test('update clears the balance threshold when the body omits it', async () => {
    const { database, d1 } = await seeded();
    database.run(`UPDATE sims SET balance_threshold = 15 WHERE iccid = 'iccid-a'`);

    await update(d1, { phone_number: '+1', sim_index: 1 });

    expect(
      database.query(`SELECT balance_threshold FROM sims WHERE iccid = 'iccid-a'`).get(),
    ).toEqual({ balance_threshold: null });
    database.close();
  });

  test('update attributes the change to system when there is no user email', async () => {
    const { database, d1 } = await seeded();
    database.run(`UPDATE sims SET updated_by = 'someone' WHERE iccid = 'iccid-a'`);

    const response = await call(d1, 'PUT', '/api/iccid-mappings/iccid-a', {
      body: { phone_number: '+1', sim_index: 1 },
      token: NO_EMAIL,
    });

    expect(response.status).toBe(200);
    expect(database.query(`SELECT updated_by FROM sims WHERE iccid = 'iccid-a'`).get()).toEqual({
      updated_by: 'system',
    });
    database.close();
  });

  test('update answers 500 when the database fails', async () => {
    const response = await update(failingDb(), { phone_number: '+1', sim_index: 1 });

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to update ICCID mapping',
    });
  });

  test('delete removes the SIM, and a SIM that does not exist still answers 200', async () => {
    const { database, d1 } = await seeded();

    const removed = await call(d1, 'DELETE', '/api/iccid-mappings/iccid-a');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      success: true,
      message: 'ICCID mapping deleted successfully',
    });
    expect(count(database, `SELECT COUNT(*) AS n FROM sims`)).toBe(0);

    const again = await call(d1, 'DELETE', '/api/iccid-mappings/iccid-a');
    expect(again.status).toBe(200);
    database.close();
  });

  test('delete answers 500 when the database fails', async () => {
    const response = await call(failingDb(), 'DELETE', '/api/iccid-mappings/iccid-a');

    expect(response.status).toBe(500);
    expect(await problemOf(response)).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to delete ICCID mapping',
    });
  });
});

describe('ICCID mapping bulk import', () => {
  async function seeded() {
    const database = await createMigratedDatabase();
    insertSim(database, 'existing', 1);
    return { database, d1: sqliteD1(database) };
  }

  const bulk = (d1: D1 & D1Batch, body: unknown) =>
    call(d1, 'POST', '/api/iccid-mappings/bulk', { body });

  test('answers 400 unless mappings is an array', async () => {
    const { database, d1 } = await seeded();

    for (const body of [{}, { mappings: 'x' }, { mappings: { iccid: 'a' } }]) {
      const response = await bulk(d1, body);
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'BAD_REQUEST',
        detail: 'Mappings must be an array',
      });
    }
    database.close();
  });

  test('answers 400 for a body that is not JSON', async () => {
    const { database, d1 } = await seeded();

    const response = await bulk(d1, 'not json');

    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('BAD_REQUEST');
    database.close();
  });

  test('creates, updates and reports failures per mapping', async () => {
    const { database, d1 } = await seeded();

    const response = await bulk(d1, {
      mappings: [
        { iccid: 'fresh', phone_number: '+2', sim_index: 2 },
        { iccid: 'existing', phone_number: '+9', sim_index: 1, carrier: 'M1' },
        { iccid: 'incomplete', phone_number: '+3' },
        { iccid: 'bad-type', phone_number: '+4', sim_index: 4, service_type: 'hybrid' },
        { iccid: 'bad-role', phone_number: '+5', sim_index: 5, sim_role: 'backup' },
      ],
    });
    const body = v.parse(BulkBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({ total: 5, created: 1, updated: 1, failed: 3 });
    expect(body.errors).toEqual([
      'Missing required fields for mapping: {"iccid":"incomplete","phone_number":"+3"}',
      'Invalid service type for ICCID bad-type: service_type must be unknown, prepaid, postpaid, or balance_managed',
      'Invalid SIM role for ICCID bad-role: sim_role must be standalone, primary, or secondary',
    ]);
    expect(
      database.query(`SELECT iccid, phone_number, carrier FROM sims ORDER BY iccid`).all(),
    ).toEqual([
      { iccid: 'existing', phone_number: '+9', carrier: 'M1' },
      { iccid: 'fresh', phone_number: '+2', carrier: null },
    ]);
    database.close();
  });

  test('counts a mapping that is not an object or has a field of the wrong type as failed', async () => {
    const { database, d1 } = await seeded();

    const response = await bulk(d1, {
      mappings: [
        null,
        'text',
        { iccid: 'typed', phone_number: '+2', sim_index: 2, carrier: 7 },
        { iccid: 'fine', phone_number: '+3', sim_index: 3 },
      ],
    });
    const body = v.parse(BulkBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({ total: 4, created: 1, updated: 0, failed: 3 });
    expect(body.errors).toEqual([
      'Missing required fields for mapping: null',
      'Missing required fields for mapping: "text"',
      'Missing required fields for mapping: {"iccid":"typed","phone_number":"+2","sim_index":2,"carrier":7}',
    ]);
    expect(database.query(`SELECT iccid FROM sims ORDER BY iccid`).all()).toEqual([
      { iccid: 'existing' },
      { iccid: 'fine' },
    ]);
    database.close();
  });

  test('a database error on one mapping is reported and the rest continue', async () => {
    const { database, d1 } = await seeded();
    database.run(`UPDATE sims SET imei = 'taken' WHERE iccid = 'existing'`);

    const response = await bulk(d1, {
      mappings: [
        { iccid: 'clash', phone_number: '+2', sim_index: 2, imei: 'taken' },
        { iccid: 'fine', phone_number: '+3', sim_index: 3 },
      ],
    });
    const body = v.parse(BulkBody, await response.json());

    expect(body.summary).toEqual({ total: 2, created: 1, updated: 0, failed: 1 });
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]).toStartWith('Failed to import mapping for ICCID clash: ');
    database.close();
  });

  test('omits errors when every mapping imports, and ignores balance_threshold', async () => {
    const { database, d1 } = await seeded();

    const response = await bulk(d1, {
      mappings: [{ iccid: 'fresh', phone_number: '+2', sim_index: 2, balance_threshold: 30 }],
    });
    const body = await response.json();

    expect(body).toEqual({
      success: true,
      summary: { total: 1, created: 1, updated: 0, failed: 0 },
    });
    expect(
      database.query(`SELECT balance_threshold FROM sims WHERE iccid = 'fresh'`).get(),
    ).toEqual({ balance_threshold: null });
    database.close();
  });
});
