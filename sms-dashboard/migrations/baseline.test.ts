import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createSchema } from '../test/schema.js';

test('schema.sql and every migration after it build on an empty database', async () => {
  const database = new Database(':memory:');

  await createSchema(database);

  expect(database.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(database.query('SELECT * FROM device_view').all()).toEqual([]);
});
