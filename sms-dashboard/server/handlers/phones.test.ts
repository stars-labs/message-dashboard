import { describe, expect, test } from 'bun:test';
import type { D1, D1Statement } from '../lib/d1.js';
import { phonesHandler } from './phones.js';

const row = {
  id: '8986000000000000001',
  imei: '860000000000001',
  iccid: '8986000000000000001',
  number: '+8613800000000',
  country: 'CN',
  carrier: 'China Mobile',
  service_type: 'prepaid',
  service_type_source: 'carrier_account',
  service_type_verified_at: null,
  sim_role: 'standalone',
  primary_iccid: null,
  balance_threshold: null,
  status: 'active',
  signal: 80,
  operator: 'CMCC',
  manufacturer: 'Quectel',
  model: 'EC20',
  usb_port: null,
  usb_path: '1-1.2',
  last_usb_path: '1-1.2',
  modem_status: 'connected',
  sim_index: 1,
  notes: null,
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

function dbReturning(rows: object[]): D1<'all' | 'first'> {
  const statement: D1Statement<'all' | 'first'> = {
    bind: () => statement,
    all: () => Promise.resolve({ results: rows }),
    first: () => Promise.resolve(rows[0] ?? null),
  };
  return { prepare: () => statement };
}

describe('phonesHandler.list', () => {
  test('returns every device_view row', async () => {
    const response = await phonesHandler.list({ env: { DB: dbReturning([row]) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [row] });
  });

  test('answers 500 when a row does not match the device_view schema', async () => {
    const response = await phonesHandler.list({
      env: { DB: dbReturning([{ ...row, sim_index: '1' }]) },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'Failed to fetch phones' });
  });
});

describe('phonesHandler.get', () => {
  test('returns the matching row', async () => {
    const response = await phonesHandler.get({
      env: { DB: dbReturning([row]) },
      params: { id: row.iccid },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: row });
  });

  test('answers 404 when no row matches', async () => {
    const response = await phonesHandler.get({
      env: { DB: dbReturning([]) },
      params: { id: 'missing' },
    });
    expect(response.status).toBe(404);
  });

  test('answers 404 without querying when the route carries no id', async () => {
    const response = await phonesHandler.get({ env: { DB: dbReturning([row]) } });
    expect(response.status).toBe(404);
  });
});
