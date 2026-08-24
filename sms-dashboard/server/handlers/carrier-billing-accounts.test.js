import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { carrierBillingAccountsHandler } from './carrier-billing-accounts.js';

function d1(database) {
  const bound = (sql, params) => ({
    sql,
    params,
    async first() { return database.query(sql).get(...params) ?? null; },
    async all() { return { results: database.query(sql).all(...params) }; },
    async run() {
      const result = database.query(sql).run(...params);
      return { meta: { changes: result.changes } };
    },
  });
  return {
    prepare(sql) { return { bind: (...params) => bound(sql, params) }; },
    async batch(statements) {
      return database.transaction(() => statements.map((statement) => {
        const result = database.query(statement.sql).run(...statement.params);
        return { meta: { changes: result.changes } };
      }))();
    },
  };
}

function request(db, {
  id,
  body = {},
  key = 'request-key',
  user = { id: 'auth0|admin' },
} = {}) {
  const headers = new Headers();
  if (key) headers.set('Idempotency-Key', key);
  return {
    env: { DB: db },
    user,
    params: id ? { id } : {},
    headers,
    json: async () => body,
  };
}

async function body(response) {
  return response.json();
}

let database;
let db;

beforeEach(async () => {
  database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sims (
      iccid TEXT PRIMARY KEY,
      sim_index INTEGER,
      phone_number TEXT,
      service_type TEXT NOT NULL,
      country_code TEXT,
      carrier TEXT
    );
    CREATE VIEW device_view AS SELECT
      iccid, sim_index, phone_number AS number, service_type,
      country_code AS country, carrier
    FROM sims;
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    INSERT INTO sims VALUES
      ('notification-sim', 79, '+6590000079', 'postpaid', 'SG', 'Singtel'),
      ('eligible-sim', 80, '+6590000080', 'postpaid', 'SG', 'Singtel'),
      ('prepaid-sim', 81, '+6590000081', 'prepaid', 'SG', 'Singtel'),
      ('starhub-sim', 82, '+6590000082', 'postpaid', 'SG', 'StarHub');
  `);
  for (const name of ['066_add_carrier_billing.sql', '067_add_carrier_billing_account_events.sql']) {
    database.exec(await Bun.file(new URL(`../../migrations/${name}`, import.meta.url)).text());
  }
  db = d1(database);
});

async function createAccount(overrides = {}) {
  return carrierBillingAccountsHandler.create(request(db, {
    key: overrides.key || 'create-account',
    body: {
      country_code: 'SG',
      carrier: 'Singtel',
      currency: 'SGD',
      display_name: 'Singtel corporate',
      notification_sim_iccid: 'notification-sim',
      account_reference: '12345678',
      ...overrides.body,
    },
  }));
}

describe('carrier billing account administration', () => {
  test('creates a pending account without retaining the full account reference', async () => {
    const response = await createAccount();
    const result = await body(response);
    const stored = database.query(`
      SELECT country_code, carrier, currency, account_ref_digest,
        account_ref_last4, status, version, created_by
      FROM carrier_billing_accounts
    `).get();

    expect(response.status).toBe(201);
    expect(result.account).toMatchObject({ status: 'pending_verification', version: 1 });
    expect(stored).toMatchObject({
      country_code: 'SG',
      carrier: 'Singtel',
      currency: 'SGD',
      account_ref_last4: '5678',
      status: 'pending_verification',
      version: 1,
      created_by: 'auth0|admin',
    });
    expect(stored.account_ref_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('12345678');
    expect(database.query(`
      SELECT event_type, actor_subject, idempotency_key
      FROM carrier_billing_account_events
    `).get()).toEqual({
      event_type: 'created',
      actor_subject: 'auth0|admin',
      idempotency_key: 'create-account',
    });
  });

  test('rejects unsupported inventory and returns an idempotent create result', async () => {
    const invalid = await createAccount({
      key: 'bad-create',
      body: { notification_sim_iccid: 'prepaid-sim' },
    });
    await createAccount();
    const retry = await createAccount();

    expect(invalid.status).toBe(400);
    expect(retry.status).toBe(200);
    expect((await body(retry)).idempotent).toBe(true);
    expect(database.query(`SELECT COUNT(*) AS count FROM carrier_billing_accounts`).get().count).toBe(1);
  });

  test('previews desired membership without writing and reports ineligible SIMs', async () => {
    const created = await body(await createAccount());
    const response = await carrierBillingAccountsHandler.previewMembers(request(db, {
      id: created.account.id,
      body: {
        expected_version: 1,
        sim_iccids: ['notification-sim', 'eligible-sim', 'prepaid-sim', 'starhub-sim'],
        verification_source: 'contract_or_bill',
      },
    }));
    const result = await body(response);

    expect(response.status).toBe(200);
    expect(result.preview_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.summary).toEqual({ requested: 4, eligible: 2, ineligible: 2, add: 2, remove: 0 });
    expect(result.ineligible.map((sim) => sim.iccid)).toEqual(['prepaid-sim', 'starhub-sim']);
    expect(database.query(`SELECT COUNT(*) AS count FROM carrier_billing_account_sims`).get().count).toBe(0);
  });

  test('applies only the exact clean preview with optimistic concurrency and audit', async () => {
    const created = await body(await createAccount());
    const previewBody = {
      expected_version: 1,
      sim_iccids: ['notification-sim', 'eligible-sim'],
      verification_source: 'contract_or_bill',
    };
    const preview = await body(await carrierBillingAccountsHandler.previewMembers(request(db, {
      id: created.account.id,
      body: previewBody,
    })));
    const applyRequest = () => request(db, {
      id: created.account.id,
      key: 'members-v1',
      body: { ...previewBody, preview_digest: preview.preview_digest },
    });

    const response = await carrierBillingAccountsHandler.applyMembers(applyRequest());
    const result = await body(response);
    const retry = await carrierBillingAccountsHandler.applyMembers(applyRequest());

    expect(response.status).toBe(200);
    expect(result.account.version).toBe(2);
    expect(database.query(`
      SELECT sim_iccid FROM carrier_billing_account_sims
      WHERE removed_at IS NULL ORDER BY sim_iccid
    `).all()).toEqual([{ sim_iccid: 'eligible-sim' }, { sim_iccid: 'notification-sim' }]);
    expect(database.query(`
      SELECT event_type, idempotency_key FROM carrier_billing_account_events
      WHERE event_type = 'members_changed'
    `).get()).toEqual({ event_type: 'members_changed', idempotency_key: 'members-v1' });
    expect(retry.status).toBe(200);
    expect((await body(retry)).idempotent).toBe(true);
  });

  test('rejects a changed or stale membership preview without mutation', async () => {
    const created = await body(await createAccount());
    const previewBody = {
      expected_version: 1,
      sim_iccids: ['notification-sim'],
      verification_source: 'carrier_account',
    };
    const preview = await body(await carrierBillingAccountsHandler.previewMembers(request(db, {
      id: created.account.id,
      body: previewBody,
    })));
    const changed = await carrierBillingAccountsHandler.applyMembers(request(db, {
      id: created.account.id,
      key: 'changed-preview',
      body: {
        ...previewBody,
        sim_iccids: ['eligible-sim'],
        preview_digest: preview.preview_digest,
      },
    }));
    database.query(`UPDATE carrier_billing_accounts SET version = 2`).run();
    const stale = await carrierBillingAccountsHandler.applyMembers(request(db, {
      id: created.account.id,
      key: 'stale-preview',
      body: { ...previewBody, preview_digest: preview.preview_digest },
    }));

    expect(changed.status).toBe(409);
    expect(stale.status).toBe(409);
    expect(database.query(`SELECT COUNT(*) AS count FROM carrier_billing_account_sims`).get().count).toBe(0);
  });

  test('activates a verified account with an audited versioned update', async () => {
    const created = await body(await createAccount());
    database.query(`
      INSERT INTO carrier_billing_account_sims (
        billing_account_id, sim_iccid, verification_source, verified_at, verified_by
      ) VALUES (?, 'notification-sim', 'carrier_account', CURRENT_TIMESTAMP, 'auth0|admin')
    `).run(created.account.id);
    const response = await carrierBillingAccountsHandler.update(request(db, {
      id: created.account.id,
      key: 'activate-v1',
      body: { expected_version: 1, status: 'active' },
    }));
    const result = await body(response);

    expect(response.status).toBe(200);
    expect(result.account).toMatchObject({ status: 'active', version: 2 });
  });
});
