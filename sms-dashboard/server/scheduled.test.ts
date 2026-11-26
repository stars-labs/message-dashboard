import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RECURRING } from '../shared/recurring.js';
import { memoryKv } from '../test/memory-kv.js';
import { createSchema } from '../test/schema.js';
import { sqliteD1 } from '../test/sqlite-d1.js';
import { runScheduled } from './scheduled.js';
import type { AlertEmail } from './utils/alerts.js';

let sqlite: Database;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  await createSchema(sqlite);
  spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  sqlite.close();
});

test('emails a silent daemon to each listed recipient, skipping blanks', async () => {
  sqlite.run(
    "INSERT INTO daemon_health (daemon_id, last_heartbeat) VALUES ('orange-pi-main', '2026-11-26 00:00:00')",
  );
  const sent: AlertEmail[] = [];

  await runScheduled(
    { cron: RECURRING.cronMaintenance.cron, scheduledTime: Date.parse('2026-11-26T01:00:00Z') },
    {
      DB: sqliteD1(sqlite),
      SESSIONS: memoryKv(),
      EMAIL: { send: (email) => Promise.resolve(void sent.push(email)) },
      ALERT_RECIPIENTS: ' ops-a@example.com, ,ops-b@example.com ',
    },
  );

  expect(sent.map(({ to }) => to)).toEqual([['ops-a@example.com', 'ops-b@example.com']]);
});

test('runs every nightly step, logging each that fails, when D1 and KV are down', async () => {
  const down = () => {
    throw new Error('down');
  };
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);

  await runScheduled(
    { cron: RECURRING.cronNightly.cron, scheduledTime: Date.now() },
    { DB: { prepare: down, batch: down }, SESSIONS: { get: down, put: down } },
  );

  expect(
    errors.mock.calls
      .map(([message]) => String(message))
      .filter((m) => m.startsWith('[scheduled]')),
  ).toEqual([
    '[scheduled] balance check maintenance failed:',
    '[scheduled] web balance maintenance failed:',
    '[scheduled] alert delivery failed:',
    '[scheduled] retention failed:',
    '[scheduled] classification sweep failed:',
    '[scheduled] carrier bill reconciliation failed:',
  ]);
  errors.mockRestore();
});
