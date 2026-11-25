import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createSchema } from '../test/schema.js';

const Names = v.array(v.object({ name: v.string() }));

let database: Database | undefined;

afterEach(() => database?.close());

describe('drop modems.current_iccid', () => {
  test('removes the legacy column and its index, keeping the live ICCID', async () => {
    database = new Database(':memory:');
    await createSchema(database);

    const columns = v.parse(Names, database.query('PRAGMA table_info(modems)').all());
    const indexes = v.parse(Names, database.query('PRAGMA index_list(modems)').all());

    expect(columns.map(({ name }) => name)).not.toContain('current_iccid');
    expect(columns.map(({ name }) => name)).toContain('detected_iccid');
    expect(indexes.map(({ name }) => name)).not.toContain('idx_modems_current_iccid');
  });
});
