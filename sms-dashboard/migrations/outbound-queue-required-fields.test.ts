import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

test('fails existing malformed queued SMS and rejects new ones on insert or update', async () => {
  using database = new Database(':memory:');
  database.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      recipient TEXT,
      phone_iccid TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      error_message TEXT
    );
    CREATE INDEX idx_messages_pending_outbound ON messages(id)
      WHERE type = 'sent' AND status = 'sending';
    INSERT INTO messages (id, type, status, recipient, phone_iccid, created_at) VALUES
      ('no-recipient', 'sent', 'sending', NULL, 'sim', '2026-11-25'),
      ('no-sim', 'sent', 'sending', '10010', NULL, '2026-11-25'),
      ('no-date', 'sent', 'sending', '10010', 'sim', NULL),
      ('ready', 'sent', 'sending', '10010', 'sim', '2026-11-25'),
      ('history', 'sent', 'sent', NULL, NULL, NULL);
  `);

  database.run(
    await Bun.file(new URL('./085_outbound_queue_required_fields.sql', import.meta.url)).text(),
  );

  expect(
    database.query(`SELECT id, status, error_message FROM messages ORDER BY id`).all(),
  ).toEqual([
    { id: 'history', status: 'sent', error_message: null },
    ...['no-date', 'no-recipient', 'no-sim'].map((id) => ({
      id,
      status: 'failed',
      error_message: 'Message has no recipient or SIM to send from',
    })),
    { id: 'ready', status: 'sending', error_message: null },
  ]);

  const insert = database.query(`
    INSERT INTO messages (id, type, status, recipient, phone_iccid, created_at)
    VALUES ('new', 'sent', 'sending', ?, ?, ?)
  `);
  const invalidQueue = 'Queued outbound SMS requires recipient, phone_iccid, and created_at';
  expect(() => insert.run(null, 'sim', '2026-11-25')).toThrow(invalidQueue);
  expect(() => insert.run('10010', null, '2026-11-25')).toThrow(invalidQueue);
  expect(() => insert.run('10010', 'sim', null)).toThrow(invalidQueue);
  expect(() => insert.run('10010', 'sim', '2026-11-25')).not.toThrow();
  expect(() => database.run(`UPDATE messages SET recipient = NULL WHERE id = 'ready'`)).toThrow(
    invalidQueue,
  );
  expect(() => database.run(`UPDATE messages SET status = 'sending' WHERE id = 'history'`)).toThrow(
    invalidQueue,
  );
  expect(() =>
    database.run(`UPDATE messages SET status = 'processing' WHERE id = 'ready'`),
  ).not.toThrow();
});
