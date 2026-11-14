import { describe, expect, test } from 'bun:test';
import { sqliteD1 } from '../../test/sqlite-d1.js';
import { countExpiredMessages, purgeExpiredMessages } from './message-retention.js';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function databaseWith(messages: { id: string; daysAgo: number; tags?: number }[]) {
  const d1 = sqliteD1();
  d1.db.run('CREATE TABLE messages (id TEXT PRIMARY KEY, timestamp DATETIME)');
  d1.db.run(
    'CREATE TABLE message_tags (message_id TEXT NOT NULL, keyword_tag_id INTEGER NOT NULL, position INTEGER NOT NULL)',
  );
  for (const message of messages) {
    d1.db
      .query('INSERT INTO messages (id, timestamp) VALUES (?, ?)')
      .run(message.id, isoDaysAgo(message.daysAgo));
    for (let tag = 0; tag < (message.tags ?? 0); tag++) {
      d1.db.query('INSERT INTO message_tags VALUES (?, ?, 0)').run(message.id, tag);
    }
  }
  return d1;
}

function ids(d1: ReturnType<typeof sqliteD1>, table: 'messages' | 'message_tags'): string[] {
  const column = table === 'messages' ? 'id' : 'message_id';
  return d1.db
    .query(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
    .all()
    .map((row) => (typeof row === 'object' && row !== null && 'id' in row ? String(row.id) : ''));
}

describe('countExpiredMessages', () => {
  test('counts only messages older than twelve months', async () => {
    const d1 = databaseWith([
      { id: 'old-1', daysAgo: 400 },
      { id: 'old-2', daysAgo: 370 },
      { id: 'recent', daysAgo: 300 },
    ]);
    expect(await countExpiredMessages(d1)).toBe(2);
  });

  test('is zero for an empty table', async () => {
    expect(await countExpiredMessages(databaseWith([]))).toBe(0);
  });
});

describe('purgeExpiredMessages', () => {
  test('deletes expired messages with their tags and keeps the rest', async () => {
    const d1 = databaseWith([
      { id: 'old-1', daysAgo: 400, tags: 2 },
      { id: 'old-2', daysAgo: 370, tags: 1 },
      { id: 'recent', daysAgo: 30, tags: 1 },
    ]);
    expect(await purgeExpiredMessages(d1)).toEqual({ deleted: 2, batches: 1, exhausted: false });
    expect(ids(d1, 'messages')).toEqual(['recent']);
    expect(ids(d1, 'message_tags')).toEqual(['recent']);
  });

  test('works through several batches', async () => {
    const d1 = databaseWith(
      Array.from({ length: 5 }, (_, i) => ({ id: `old-${String(i)}`, daysAgo: 400 + i })),
    );
    expect(await purgeExpiredMessages(d1, { batchSize: 2 })).toEqual({
      deleted: 5,
      batches: 3,
      exhausted: false,
    });
    expect(ids(d1, 'messages')).toEqual([]);
  });

  test('reports exhaustion when the batch cap stops it with work left', async () => {
    const d1 = databaseWith(
      Array.from({ length: 5 }, (_, i) => ({ id: `old-${String(i)}`, daysAgo: 400 + i })),
    );
    expect(await purgeExpiredMessages(d1, { batchSize: 2, maxBatches: 1 })).toEqual({
      deleted: 2,
      batches: 1,
      exhausted: true,
    });
    expect(ids(d1, 'messages')).toHaveLength(3);
  });

  test('deletes the oldest messages first', async () => {
    const d1 = databaseWith([
      { id: 'older', daysAgo: 500 },
      { id: 'old', daysAgo: 400 },
    ]);
    await purgeExpiredMessages(d1, { batchSize: 1, maxBatches: 1 });
    expect(ids(d1, 'messages')).toEqual(['old']);
  });
});
