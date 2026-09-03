import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { controlHandler } from './control.js';

let sqlite;

function d1(database) {
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...nextParams) {
        return statement(sql, nextParams);
      },
      async run() {
        const result = database.query(sql).run(...params);
        return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
      },
      async all() {
        return { results: database.query(sql).all(...params) };
      },
      async first() {
        return database.query(sql).get(...params) ?? null;
      },
    };
  }

  return {
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      return statements.map((item) => {
        const result = database.query(item.sql).run(...item.params);
        return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
      });
    },
  };
}

function request(db, body) {
  return {
    env: { API_KEY: 'secret', DB: db },
    headers: new Headers({ 'X-API-Key': 'secret' }),
    json: async () => body,
  };
}

function report(overrides = {}) {
  return {
    equipment_id: 'modem-a',
    manufacturer: 'Quectel',
    model: 'EC20',
    firmware_revision: '1',
    hardware_revision: '1',
    detected_iccid: 'iccid-a',
    detected_phone_number: null,
    detected_operator: 'carrier',
    signal_percent: 80,
    rssi: -70,
    modem_index: 1,
    usb_port: 1,
    usb_path: '1-1',
    status: 'active',
    ...overrides,
  };
}

function body(syncMode = 'incremental', reports = [report()]) {
  return {
    modem_reports: reports,
    removed_equipment_ids: [],
    sync_mode: syncMode,
    session_id: 'session-1',
    timestamp: '2026-09-02T00:00:00.000Z',
  };
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE modems (
      equipment_id TEXT PRIMARY KEY,
      manufacturer TEXT,
      model TEXT,
      firmware_revision TEXT,
      hardware_revision TEXT,
      detected_iccid TEXT,
      detected_phone_number TEXT,
      detected_operator TEXT,
      signal_percent INTEGER,
      rssi INTEGER,
      modem_index INTEGER,
      usb_port INTEGER,
      usb_path TEXT,
      last_usb_path TEXT,
      status TEXT,
      verification_status TEXT DEFAULT 'unverified',
      last_verified_session TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE modem_update_log (equipment_id TEXT NOT NULL);
    CREATE TRIGGER audit_modem_update AFTER UPDATE ON modems
    BEGIN
      INSERT INTO modem_update_log (equipment_id) VALUES (NEW.equipment_id);
    END;
  `);
});

afterEach(() => sqlite.close());

describe('device synchronization write suppression', () => {
  test('suppresses unchanged reports and persists every delta selected by the daemon', async () => {
    const db = d1(sqlite);

    expect((await controlHandler.updateDevices(request(db, body()))).status).toBe(200);
    expect((await controlHandler.updateDevices(request(db, body()))).status).toBe(200);
    expect(sqlite.query('SELECT COUNT(*) AS count FROM modem_update_log').get().count).toBe(0);

    expect((await controlHandler.updateDevices(request(db, body('incremental', [
      report({ signal_percent: 60 }),
    ])))).status).toBe(200);
    expect(sqlite.query('SELECT COUNT(*) AS count FROM modem_update_log').get().count).toBe(1);

    expect((await controlHandler.updateDevices(request(db, body('incremental', [
      report({ signal_percent: 60, status: 'connected' }),
    ])))).status).toBe(200);
    expect(sqlite.query('SELECT COUNT(*) AS count FROM modem_update_log').get().count).toBe(2);
  });

  test('full sync updates present and missing modems once, then becomes write-free', async () => {
    const db = d1(sqlite);
    sqlite.query(`
      INSERT INTO modems (
        equipment_id, manufacturer, model, firmware_revision, hardware_revision,
        detected_iccid, detected_operator, signal_percent, rssi, modem_index,
        usb_port, usb_path, last_usb_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('modem-a', 'Quectel', 'EC20', '1', '1', 'iccid-a', 'carrier', 80, -70, 1, 1, '1-1', '1-1', 'active');
    sqlite.query(`
      INSERT INTO modems (equipment_id, detected_iccid, signal_percent, rssi, usb_path, status)
      VALUES ('modem-b', 'iccid-b', 40, -90, '1-2', 'active')
    `).run();

    expect((await controlHandler.updateDevices(request(db, body('full')))).status).toBe(200);
    expect((await controlHandler.updateDevices(request(db, body('full')))).status).toBe(200);

    expect(sqlite.query(`
      SELECT equipment_id, COUNT(*) AS count
      FROM modem_update_log
      GROUP BY equipment_id
      ORDER BY equipment_id
    `).all()).toEqual([
      { equipment_id: 'modem-a', count: 1 },
      { equipment_id: 'modem-b', count: 1 },
    ]);
    expect(sqlite.query(`
      SELECT status, verification_status, detected_iccid, signal_percent, rssi, usb_path
      FROM modems WHERE equipment_id = 'modem-b'
    `).get()).toEqual({
      status: 'disconnected',
      verification_status: 'absent',
      detected_iccid: null,
      signal_percent: null,
      rssi: null,
      usb_path: null,
    });
  });

  test('an empty full snapshot disconnects every previously present modem', async () => {
    const db = d1(sqlite);
    sqlite.query(`
      INSERT INTO modems (equipment_id, detected_iccid, signal_percent, rssi, usb_path, status)
      VALUES
        ('modem-a', 'iccid-a', 80, -70, '1-1', 'active'),
        ('modem-b', 'iccid-b', 40, -90, '1-2', 'active')
    `).run();

    const response = await controlHandler.updateDevices(request(db, body('full', [])));

    expect(response.status).toBe(200);
    expect(sqlite.query(`
      SELECT equipment_id, status, verification_status
      FROM modems ORDER BY equipment_id
    `).all()).toEqual([
      { equipment_id: 'modem-a', status: 'disconnected', verification_status: 'absent' },
      { equipment_id: 'modem-b', status: 'disconnected', verification_status: 'absent' },
    ]);
  });

  test('marks explicitly removed modems disconnected during incremental sync', async () => {
    const db = d1(sqlite);
    sqlite.query(`
      INSERT INTO modems (equipment_id, detected_iccid, signal_percent, rssi, usb_path, status)
      VALUES ('modem-b', 'iccid-b', 40, -90, '1-2', 'active')
    `).run();

    const payload = body('incremental', []);
    payload.removed_equipment_ids = ['modem-b'];
    const response = await controlHandler.updateDevices(request(db, payload));

    expect(response.status).toBe(200);
    expect(sqlite.query(`
      SELECT status, verification_status, detected_iccid, signal_percent, rssi, usb_path
      FROM modems WHERE equipment_id = 'modem-b'
    `).get()).toEqual({
      status: 'disconnected',
      verification_status: 'absent',
      detected_iccid: null,
      signal_percent: null,
      rssi: null,
      usb_path: null,
    });
  });

  test('requires the explicit removal set in the device payload contract', async () => {
    const payload = body();
    delete payload.removed_equipment_ids;

    expect((await controlHandler.updateDevices(request(d1(sqlite), payload))).status).toBe(400);
  });

  test('rejects the removed legacy device payload without touching D1', async () => {
    const calls = [];
    const db = { prepare(sql) { calls.push(sql); throw new Error('unexpected D1 access'); } };
    const response = await controlHandler.updateDevices(request(db, {
      modems: [report()],
      sims: [],
      sync_mode: 'incremental',
      session_id: 'session-1',
    }));

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
