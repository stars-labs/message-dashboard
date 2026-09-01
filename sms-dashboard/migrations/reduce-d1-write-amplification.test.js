import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

describe('D1 write-amplification migration', () => {
  test('removes the duplicate modem update trigger and unused heartbeat index', async () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE modems (equipment_id TEXT PRIMARY KEY, updated_at TEXT);
      CREATE TRIGGER update_modems_timestamp
      AFTER UPDATE ON modems
      BEGIN
        UPDATE modems SET updated_at = CURRENT_TIMESTAMP WHERE equipment_id = NEW.equipment_id;
      END;
      CREATE TABLE daemon_health (daemon_id TEXT PRIMARY KEY, last_heartbeat TEXT NOT NULL);
      CREATE INDEX idx_daemon_health_heartbeat ON daemon_health(last_heartbeat);
    `);

    const migration = await Bun.file(new URL(
      './071_reduce_d1_write_amplification.sql',
      import.meta.url,
    )).text();
    database.exec(migration);

    expect(database.query(`
      SELECT name FROM sqlite_master
      WHERE name IN ('update_modems_timestamp', 'idx_daemon_health_heartbeat')
      ORDER BY name
    `).all()).toEqual([]);
    database.close();
  });
});
