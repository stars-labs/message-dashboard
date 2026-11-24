import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { memoryKv } from '../../test/memory-kv.js';
import { createSchema } from '../../test/schema.js';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { callWorker } from '../../test/worker-harness.js';
import type { D1, D1Batch } from '../lib/d1.js';

let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

const ADMIN = 'session-admin';
const VIEWER = 'session-viewer';

function session(roles: string[]): string {
  return JSON.stringify({
    user: { id: 'auth0|admin', email: 'someone@example.test', roles },
    expires_at: Date.now() + 3_600_000,
  });
}

const SESSIONS = memoryKv({
  [ADMIN]: session(['sms-admin']),
  [VIEWER]: session(['sms-viewer']),
});

async function call(DB: D1 & D1Batch, token = ADMIN): Promise<Response> {
  const { response } = await callWorker('GET', '/api/phones', {
    headers: { Cookie: `auth_token=${token}` },
    bindings: { DB, SESSIONS },
  });
  return response;
}

const Problem = v.looseObject({
  type: v.string(),
  title: v.string(),
  status: v.number(),
  detail: v.string(),
  code: v.string(),
});

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return v.parse(Problem, await response.json());
}

const PhonesBody = v.object({
  success: v.literal(true),
  data: v.array(v.looseObject({ iccid: v.string() })),
});

async function seeded() {
  const database = new Database(':memory:');
  await createSchema(database);
  const insert = database.query(
    `INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier)
     VALUES (?, ?, ?, 'SG', 'Singtel')`,
  );
  insert.run('iccid-b', 2, '+6500000002');
  insert.run('iccid-a', 1, '+6500000001');
  return { database, d1: sqliteD1(database) };
}

describe('GET /api/phones', () => {
  test('returns every device_view row', async () => {
    const { database, d1 } = await seeded();

    const response = await call(d1);
    const body = v.parse(PhonesBody, await response.json());

    expect(response.status).toBe(200);
    expect(body.data.map((phone) => phone.iccid)).toEqual(['iccid-a', 'iccid-b']);
    expect(body.data[0]).toMatchObject({
      id: 'iccid-a',
      imei: null,
      number: '+6500000001',
      country: 'SG',
      carrier: 'Singtel',
      service_type: 'unknown',
      sim_role: 'standalone',
      status: 'unassigned',
      sim_index: 1,
    });
    database.close();
  });

  test('a viewer may read it', async () => {
    const { database, d1 } = await seeded();

    expect((await call(d1, VIEWER)).status).toBe(200);
    database.close();
  });

  test('answers 401 without a credential the middleware accepts', async () => {
    const { database, d1 } = await seeded();

    expect((await call(d1, 'unknown')).status).toBe(401);
    database.close();
  });

  test('answers 500 when a row does not match the device_view schema', async () => {
    const database = new Database(':memory:');
    await createSchema(database);
    database.run(`DROP VIEW device_view`);
    database.run(`CREATE VIEW device_view AS SELECT
      '1' AS id, NULL AS equipment_id, '1' AS iccid, 'n' AS number, NULL AS country,
      NULL AS carrier, 'unknown' AS service_type, NULL AS service_type_source,
      NULL AS service_type_verified_at, 'standalone' AS sim_role, NULL AS primary_iccid,
      NULL AS balance_threshold, 'active' AS sim_status, NULL AS signal_quality,
      NULL AS operator, NULL AS manufacturer, NULL AS model, NULL AS primary_port,
      NULL AS usb_path, NULL AS last_usb_path, NULL AS modem_status, 'x' AS sim_index,
      NULL AS notes, NULL AS created_at, NULL AS updated_at`);

    const response = await call(sqliteD1(database));
    const problem = await problemOf(response);

    expect(response.status).toBe(500);
    expect(problem).toMatchObject({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      detail: 'Failed to fetch phones',
    });
    database.close();
  });
});
