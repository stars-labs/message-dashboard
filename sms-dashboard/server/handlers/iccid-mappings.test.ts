import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { createSimsSchema } from '../../test/sims-schema.js';
import type { D1, D1Statement } from '../lib/d1.js';
import { iccidMappingsHandler, resolveServiceType, resolveSimRole } from './iccid-mappings.js';

async function createMigratedDatabase() {
  const database = new Database(':memory:');
  await createSimsSchema(database);
  return database;
}

function bodyOf(value: unknown) {
  return { text: () => Promise.resolve(JSON.stringify(value)) };
}

function rawBodyOf(text: string) {
  return { text: () => Promise.resolve(text) };
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

function failingDb(): D1 {
  return {
    prepare() {
      throw new Error('D1 is down');
    },
  };
}

function rowsDb(row: unknown): D1<'all' | 'first'> {
  function statement(): D1Statement<'all' | 'first'> {
    return {
      bind: statement,
      all: () => Promise.resolve({ results: [row] }),
      first: () => Promise.resolve(row),
    };
  }
  return { prepare: statement };
}

const NumberRow = v.object({ n: v.number() });

function count(database: Database, sql: string): number {
  return v.parse(NumberRow, database.query(sql).get()).n;
}

const ErrorBody = v.looseObject({ success: v.literal(false), error: v.string() });
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

async function errorOf(response: Response): Promise<string> {
  return v.parse(ErrorBody, await response.json()).error;
}

async function dataOf(response: Response) {
  return v.parse(DataBody, await response.json()).data;
}

const user = { email: 'operator@example.com' };

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
    const env = { DB: sqliteD1(database) };

    const createResponse = await iccidMappingsHandler.create({
      env,
      user,
      ...bodyOf({
        iccid: 'test-iccid',
        sim_index: 1,
        phone_number: '+6500000000',
        country_code: 'SG',
        carrier: 'Test Carrier',
        service_type: 'postpaid',
        service_type_source: 'contract_or_bill',
      }),
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
    expect(confirmed.updated_by).toBe(user.email);

    const updateResponse = await iccidMappingsHandler.update({
      env,
      user,
      params: { id: 'test-iccid' },
      ...bodyOf({
        phone_number: '+6500000000',
        sim_index: 1,
        country_code: 'SG',
        carrier: 'Test Carrier',
        service_type: 'unknown',
        service_type_source: null,
      }),
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

  test('full create+update lifecycle through the handler', async () => {
    const database = await createMigratedDatabase();
    const env = { DB: sqliteD1(database) };
    const operator = { email: 'op@example.com' };

    const primaryResp = await iccidMappingsHandler.create({
      env,
      user: operator,
      ...bodyOf({
        iccid: 'primary-1',
        sim_index: 1,
        phone_number: '+861',
        sim_role: 'primary',
      }),
    });
    expect(primaryResp.status).toBe(201);

    const secResp = await iccidMappingsHandler.create({
      env,
      user: operator,
      ...bodyOf({
        iccid: 'secondary-1',
        sim_index: 2,
        phone_number: '+862',
        sim_role: 'secondary',
        primary_iccid: 'primary-1',
      }),
    });
    expect(secResp.status).toBe(201);

    const sec = database
      .query(`SELECT sim_role, primary_iccid FROM sims WHERE iccid = 'secondary-1'`)
      .get();
    expect(sec).toEqual({ sim_role: 'secondary', primary_iccid: 'primary-1' });

    const updateResp = await iccidMappingsHandler.update({
      env,
      user: operator,
      params: { id: 'secondary-1' },
      ...bodyOf({
        phone_number: '+862',
        sim_index: 2,
        sim_role: 'standalone',
      }),
    });
    expect(updateResp.status).toBe(200);
    const cleared = database
      .query(`SELECT sim_role, primary_iccid FROM sims WHERE iccid = 'secondary-1'`)
      .get();
    expect(cleared).toEqual({ sim_role: 'standalone', primary_iccid: null });

    const delResp = await iccidMappingsHandler.delete({
      env,
      params: { id: 'primary-1' },
    });
    expect(delResp.status).toBe(200);
    database.close();
  });

  test('delete returns 409 when secondaries are still attached', async () => {
    const database = await createMigratedDatabase();
    const env = { DB: sqliteD1(database) };
    const operator = { email: 'op@example.com' };

    await iccidMappingsHandler.create({
      env,
      user: operator,
      ...bodyOf({ iccid: 'p', sim_index: 1, phone_number: 'n', sim_role: 'primary' }),
    });
    await iccidMappingsHandler.create({
      env,
      user: operator,
      ...bodyOf({
        iccid: 's',
        sim_index: 2,
        phone_number: 'n2',
        sim_role: 'secondary',
        primary_iccid: 'p',
      }),
    });

    const delResp = await iccidMappingsHandler.delete({ env, params: { id: 'p' } });
    expect(delResp.status).toBe(409);
    expect(await errorOf(delResp)).toMatch(/primary SIM with secondary/);
    database.close();
  });
});

describe('ICCID mapping reads', () => {
  async function seeded() {
    const database = await createMigratedDatabase();
    insertSim(database, 'iccid-b', 2, { carrier: 'M1', notes: 'second desk' });
    insertSim(database, 'iccid-a', 1);
    insertSim(database, 'iccid-c', 3, { carrier: 'Singtel' });
    return { database, env: { DB: sqliteD1(database) } };
  }

  test('lists mappings by sim_index with the device_view columns and pagination', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.list({
      env,
      url: 'https://example.com/api/iccid-mappings',
    });
    const body = v.parse(ListBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(body.data.map((row) => row.iccid)).toEqual(['iccid-a', 'iccid-b', 'iccid-c']);
    expect(body.data[1]).toEqual({
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
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    database.close();
  });

  test('filters by search text and pages the result', async () => {
    const { database, env } = await seeded();

    const searched = await iccidMappingsHandler.list({
      env,
      url: 'https://example.com/api/iccid-mappings?search=Singtel',
    });
    const searchedBody = v.parse(ListBody, await searched.json());
    expect(searchedBody.data.map((row) => row.iccid)).toEqual(['iccid-a', 'iccid-c']);
    expect(searchedBody.pagination.total).toBe(2);

    const paged = await iccidMappingsHandler.list({
      env,
      url: 'https://example.com/api/iccid-mappings?page=2&limit=2',
    });
    const pagedBody = v.parse(ListBody, await paged.json());
    expect(pagedBody.data.map((row) => row.iccid)).toEqual(['iccid-c']);
    expect(pagedBody.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    database.close();
  });

  test('list answers 400 for a page or limit that is not a positive integer', async () => {
    const { database, env } = await seeded();

    for (const query of ['page=abc', 'page=0', 'page=-1', 'page=1.5', 'limit=abc', 'limit=0']) {
      const response = await iccidMappingsHandler.list({
        env,
        url: `https://example.com/api/iccid-mappings?${query}`,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: 'page and limit must be positive integers',
      });
    }
    database.close();
  });

  test('list answers 500 with the error detail when the database fails', async () => {
    const response = await iccidMappingsHandler.list({
      env: { DB: failingDb() },
      url: 'https://example.com/api/iccid-mappings',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to fetch ICCID mappings',
      detail: 'D1 is down',
    });
  });

  test('list answers 500 when a row does not match the schema', async () => {
    const response = await iccidMappingsHandler.list({
      env: { DB: rowsDb({ iccid: 5 }) },
      url: 'https://example.com/api/iccid-mappings',
    });

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toBe('Failed to fetch ICCID mappings');
  });

  test('get and getByIccid return one mapping or 404', async () => {
    const { database, env } = await seeded();

    const found = await iccidMappingsHandler.get({ env, params: { id: 'iccid-a' } });
    expect(found.status).toBe(200);
    expect(await dataOf(found)).toMatchObject({ iccid: 'iccid-a', sim_index: 1 });

    const byIccid = await iccidMappingsHandler.getByIccid({ env, params: { iccid: 'iccid-c' } });
    expect(byIccid.status).toBe(200);
    expect(await dataOf(byIccid)).toMatchObject({ iccid: 'iccid-c', sim_index: 3 });

    const missing = await iccidMappingsHandler.get({ env, params: { id: 'nope' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ success: false, error: 'ICCID mapping not found' });

    const missingByIccid = await iccidMappingsHandler.getByIccid({
      env,
      params: { iccid: 'nope' },
    });
    expect(missingByIccid.status).toBe(404);
    expect(await missingByIccid.json()).toEqual({ success: false, error: 'ICCID not found' });
    database.close();
  });

  test('get and getByIccid answer 500 when the database fails or a row has the wrong shape', async () => {
    for (const db of [failingDb(), rowsDb({ iccid: 5 })]) {
      const get = await iccidMappingsHandler.get({ env: { DB: db }, params: { id: 'a' } });
      expect(get.status).toBe(500);
      expect(await get.json()).toEqual({ success: false, error: 'Failed to fetch ICCID mapping' });

      const byIccid = await iccidMappingsHandler.getByIccid({
        env: { DB: db },
        params: { iccid: 'a' },
      });
      expect(byIccid.status).toBe(500);
      expect(await byIccid.json()).toEqual({
        success: false,
        error: 'Failed to fetch ICCID mapping',
      });
    }
  });
});

describe('ICCID mapping writes', () => {
  async function seeded() {
    const database = await createMigratedDatabase();
    insertSim(database, 'iccid-a', 1);
    return { database, env: { DB: sqliteD1(database) } };
  }

  test('create without iccid, phone_number or sim_index answers 400', async () => {
    const { database, env } = await seeded();

    for (const body of [
      { phone_number: '+1', sim_index: 5 },
      { iccid: 'x', sim_index: 5 },
      { iccid: 'x', phone_number: '+1' },
      { iccid: 'x', phone_number: '+1', sim_index: 0 },
    ]) {
      const response = await iccidMappingsHandler.create({ env, user, ...bodyOf(body) });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('ICCID, phone number, and sim_index are required');
    }
    database.close();
  });

  test('create answers 400 with the resolver message for a bad service type or role', async () => {
    const { database, env } = await seeded();
    const base = { iccid: 'x', phone_number: '+1', sim_index: 5 };

    const serviceType = await iccidMappingsHandler.create({
      env,
      user,
      ...bodyOf({ ...base, service_type: 'hybrid' }),
    });
    expect(serviceType.status).toBe(400);
    expect(await serviceType.json()).toEqual({
      success: false,
      error: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });

    const role = await iccidMappingsHandler.create({
      env,
      user,
      ...bodyOf({ ...base, sim_role: 'backup' }),
    });
    expect(role.status).toBe(400);
    expect(await role.json()).toEqual({
      success: false,
      error: 'sim_role must be standalone, primary, or secondary',
    });
    database.close();
  });

  test('create inserts with 201 and returns the stored mapping; a repeat updates with 200', async () => {
    const { database, env } = await seeded();
    const payload = {
      iccid: 'iccid-new',
      phone_number: '+6599999999',
      sim_index: 7,
      country_code: 'SG',
      carrier: 'StarHub',
      notes: 'front desk',
      balance_threshold: 12.5,
    };

    const created = await iccidMappingsHandler.create({ env, user, ...bodyOf(payload) });
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

    const repeated = await iccidMappingsHandler.create({
      env,
      user,
      ...bodyOf({ ...payload, carrier: 'M1', notes: '' }),
    });
    expect(repeated.status).toBe(200);
    expect(await dataOf(repeated)).toMatchObject({ carrier: 'M1', notes: null });
    expect(count(database, `SELECT COUNT(*) AS n FROM sims`)).toBe(2);
    database.close();
  });

  test('create stores a numeric threshold and no threshold for null or an omitted one', async () => {
    const { database, env } = await seeded();
    const base = { phone_number: '+1', sim_index: 5 };

    for (const [iccid, extra] of [
      ['with', { balance_threshold: 8 }],
      ['null', { balance_threshold: null }],
      ['omitted', {}],
    ] as const) {
      const response = await iccidMappingsHandler.create({
        env,
        user,
        ...bodyOf({ ...base, iccid, ...extra }),
      });
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
    const { database, env } = await seeded();
    const base = { phone_number: '+1', sim_index: 5 };

    for (const balanceThreshold of ['8', 'abc', '']) {
      const response = await iccidMappingsHandler.create({
        env,
        user,
        ...bodyOf({ ...base, iccid: 'text', balance_threshold: balanceThreshold }),
      });
      expect(response.status).toBe(400);
    }
    expect(count(database, `SELECT COUNT(*) AS n FROM sims WHERE iccid = 'text'`)).toBe(0);
    database.close();
  });

  test('create answers 400 for a body that is not JSON or has fields of the wrong type', async () => {
    const { database, env } = await seeded();
    const base = { iccid: 'x', phone_number: '+1', sim_index: 5 };

    for (const request of [
      rawBodyOf('not json'),
      bodyOf(null),
      bodyOf([]),
      bodyOf({ ...base, iccid: 7 }),
      bodyOf({ ...base, phone_number: 7 }),
      bodyOf({ ...base, sim_index: '5' }),
      bodyOf({ ...base, sim_index: 1.5 }),
      bodyOf({ ...base, carrier: 7 }),
      bodyOf({ ...base, notes: { text: 'x' } }),
      bodyOf({ ...base, service_type: 7 }),
      bodyOf({ ...base, sim_role: 7 }),
    ]) {
      const response = await iccidMappingsHandler.create({ env, user, ...request });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('ICCID, phone number, and sim_index are required');
    }
    expect(count(database, `SELECT COUNT(*) AS n FROM sims WHERE iccid = 'x'`)).toBe(0);
    database.close();
  });

  test('create answers 500 with the error detail when the database fails', async () => {
    const response = await iccidMappingsHandler.create({
      env: { DB: failingDb() },
      user,
      ...bodyOf({ iccid: 'x', phone_number: '+1', sim_index: 5 }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to create ICCID mapping',
      detail: 'D1 is down',
    });
  });

  test('update answers 404 for an unknown SIM', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.update({
      env,
      user,
      params: { id: 'nope' },
      ...bodyOf({ phone_number: '+1', sim_index: 5 }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'ICCID mapping not found' });
    database.close();
  });

  test('update answers 400 with the resolver message for a bad service type', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.update({
      env,
      user,
      params: { id: 'iccid-a' },
      ...bodyOf({ phone_number: '+1', sim_index: 5, service_type: 'n/a' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'service_type must be unknown, prepaid, postpaid, or balance_managed',
    });
    database.close();
  });

  test('update answers 400 for a body that is not JSON or lacks phone_number and sim_index', async () => {
    const { database, env } = await seeded();

    for (const request of [
      rawBodyOf('not json'),
      bodyOf({ sim_index: 1 }),
      bodyOf({ phone_number: '+1' }),
      bodyOf({ phone_number: '', sim_index: 1 }),
      bodyOf({ phone_number: '+1', sim_index: 0 }),
      bodyOf({ phone_number: '+1', sim_index: 1, carrier: 7 }),
      bodyOf({ phone_number: '+1', sim_index: 1, balance_threshold: 'abc' }),
    ]) {
      const response = await iccidMappingsHandler.update({
        env,
        user,
        params: { id: 'iccid-a' },
        ...request,
      });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe('phone_number and sim_index are required');
    }
    expect(database.query(`SELECT phone_number FROM sims WHERE iccid = 'iccid-a'`).get()).toEqual({
      phone_number: '+6500000001',
    });
    database.close();
  });

  test('update rewrites the row, returns the detail, and attributes it to the user', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.update({
      env,
      user,
      params: { id: 'iccid-a' },
      ...bodyOf({
        phone_number: '+6588888888',
        sim_index: 9,
        carrier: 'M1',
        notes: 'moved',
        balance_threshold: 20,
      }),
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
    ).toEqual({ balance_threshold: 20, updated_by: 'operator@example.com' });
    database.close();
  });

  test('update clears the balance threshold when the body omits it', async () => {
    const { database, env } = await seeded();
    database.run(`UPDATE sims SET balance_threshold = 15 WHERE iccid = 'iccid-a'`);

    await iccidMappingsHandler.update({
      env,
      user,
      params: { id: 'iccid-a' },
      ...bodyOf({ phone_number: '+1', sim_index: 1 }),
    });

    expect(
      database.query(`SELECT balance_threshold FROM sims WHERE iccid = 'iccid-a'`).get(),
    ).toEqual({ balance_threshold: null });
    database.close();
  });

  test('update attributes the change to system when there is no user email', async () => {
    const { database, env } = await seeded();

    for (const operator of [undefined, { email: '' }]) {
      database.run(`UPDATE sims SET updated_by = 'someone' WHERE iccid = 'iccid-a'`);
      await iccidMappingsHandler.update({
        env,
        ...(operator ? { user: operator } : {}),
        params: { id: 'iccid-a' },
        ...bodyOf({ phone_number: '+1', sim_index: 1 }),
      });

      expect(database.query(`SELECT updated_by FROM sims WHERE iccid = 'iccid-a'`).get()).toEqual({
        updated_by: 'system',
      });
    }
    database.close();
  });

  test('update answers 500 when the database fails', async () => {
    const response = await iccidMappingsHandler.update({
      env: { DB: failingDb() },
      user,
      params: { id: 'iccid-a' },
      ...bodyOf({ phone_number: '+1', sim_index: 1 }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to update ICCID mapping',
    });
  });

  test('delete removes the SIM, and a SIM that does not exist still answers 200', async () => {
    const { database, env } = await seeded();

    const removed = await iccidMappingsHandler.delete({ env, params: { id: 'iccid-a' } });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      success: true,
      message: 'ICCID mapping deleted successfully',
    });
    expect(count(database, `SELECT COUNT(*) AS n FROM sims`)).toBe(0);

    const again = await iccidMappingsHandler.delete({ env, params: { id: 'iccid-a' } });
    expect(again.status).toBe(200);
    database.close();
  });

  test('delete answers 500 when the database fails', async () => {
    const response = await iccidMappingsHandler.delete({
      env: { DB: failingDb() },
      params: { id: 'iccid-a' },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to delete ICCID mapping',
    });
  });
});

describe('ICCID mapping bulk import', () => {
  async function seeded() {
    const database = await createMigratedDatabase();
    insertSim(database, 'existing', 1);
    return { database, env: { DB: sqliteD1(database) } };
  }

  test('answers 400 unless mappings is an array', async () => {
    const { database, env } = await seeded();

    for (const body of [{}, { mappings: 'x' }, { mappings: { iccid: 'a' } }]) {
      const response = await iccidMappingsHandler.bulkImport({ env, user, ...bodyOf(body) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ success: false, error: 'Mappings must be an array' });
    }
    database.close();
  });

  test('answers 400 for a body that is not JSON', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.bulkImport({
      env,
      user,
      ...rawBodyOf('not json'),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'Mappings must be an array' });
    database.close();
  });

  test('creates, updates and reports failures per mapping', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.bulkImport({
      env,
      user,
      ...bodyOf({
        mappings: [
          { iccid: 'fresh', phone_number: '+2', sim_index: 2 },
          { iccid: 'existing', phone_number: '+9', sim_index: 1, carrier: 'M1' },
          { iccid: 'incomplete', phone_number: '+3' },
          { iccid: 'bad-type', phone_number: '+4', sim_index: 4, service_type: 'hybrid' },
          { iccid: 'bad-role', phone_number: '+5', sim_index: 5, sim_role: 'backup' },
        ],
      }),
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
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.bulkImport({
      env,
      user,
      ...bodyOf({
        mappings: [
          null,
          'text',
          { iccid: 'typed', phone_number: '+2', sim_index: 2, carrier: 7 },
          { iccid: 'fine', phone_number: '+3', sim_index: 3 },
        ],
      }),
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
    const { database, env } = await seeded();
    database.run(`UPDATE sims SET imei = 'taken' WHERE iccid = 'existing'`);

    const response = await iccidMappingsHandler.bulkImport({
      env,
      user,
      ...bodyOf({
        mappings: [
          { iccid: 'clash', phone_number: '+2', sim_index: 2, imei: 'taken' },
          { iccid: 'fine', phone_number: '+3', sim_index: 3 },
        ],
      }),
    });
    const body = v.parse(BulkBody, await response.json());

    expect(body.summary).toEqual({ total: 2, created: 1, updated: 0, failed: 1 });
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]).toStartWith('Failed to import mapping for ICCID clash: ');
    database.close();
  });

  test('omits errors when every mapping imports, and ignores balance_threshold', async () => {
    const { database, env } = await seeded();

    const response = await iccidMappingsHandler.bulkImport({
      env,
      user,
      ...bodyOf({
        mappings: [{ iccid: 'fresh', phone_number: '+2', sim_index: 2, balance_threshold: 30 }],
      }),
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
