import { describe, expect, test } from 'bun:test';
import { sqliteD1 } from './sqlite-d1.js';

function withAuditTrigger() {
  const d1 = sqliteD1();
  d1.db.run(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, value INTEGER);
    CREATE TABLE audit (id INTEGER);
    CREATE TRIGGER audit_items AFTER UPDATE ON items
    BEGIN
      INSERT INTO audit VALUES (NEW.id);
    END;
    INSERT INTO items VALUES (1, 0), (2, 0);
  `);
  return d1;
}

describe('sqliteD1', () => {
  test('counts only the rows a statement changed, as D1 does, not a trigger’s writes', async () => {
    const d1 = withAuditTrigger();

    const result = await d1.prepare('UPDATE items SET value = 1').run();

    expect(result.meta.changes).toBe(2);
  });

  test('counts each batched statement the same way', async () => {
    const d1 = withAuditTrigger();

    const results = await d1.batch([
      d1.prepare('UPDATE items SET value = 1 WHERE id = ?').bind(1),
      d1.prepare('UPDATE items SET value = 1'),
    ]);

    expect(results.map((result) => result.meta.changes)).toEqual([1, 2]);
  });
});
