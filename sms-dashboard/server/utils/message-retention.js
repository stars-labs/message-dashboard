// Message retention: everything is kept for 12 months, then deleted.
//
// Applies to received and sent alike, filtered or not. Spam is retained just as
// long as anything else, so a rule that turns out to be wrong can still be
// audited months later.

/** SQLite date modifier defining the retention window. */
export const RETENTION_MODIFIER = '-12 months';

/**
 * Timestamps are stored as ISO-8601 with a T separator and a Z suffix (migration
 * 018 normalised them). datetime() would return a space-separated, Z-less string,
 * which compares wrongly against that format, so build the cutoff with strftime
 * in exactly the stored shape.
 */
const CUTOFF_EXPR = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)`;

/**
 * Rows per batch. Also the bound-parameter count per statement, kept well under
 * SQLite's variable limit.
 */
const BATCH_SIZE = 200;

/** Safety stop, so a bug cannot turn into an unbounded delete loop. */
const MAX_BATCHES = 50;

/** How many messages are currently past the retention window. */
export async function countExpiredMessages(db, modifier = RETENTION_MODIFIER) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE timestamp < ${CUTOFF_EXPR}`)
    .bind(modifier)
    .first();
  return row?.n ?? 0;
}

/**
 * Delete messages older than the retention window, in bounded batches.
 *
 * Deletes by explicit id list rather than `DELETE ... LIMIT`, which depends on a
 * SQLite compile-time option, and removes each message's keyword tags in the same
 * batch rather than relying on ON DELETE CASCADE — foreign key enforcement is not
 * guaranteed to be on, and orphaned message_tags rows would accumulate silently.
 *
 * @returns {Promise<{deleted: number, batches: number, exhausted: boolean}>}
 */
export async function purgeExpiredMessages(
  db,
  { modifier = RETENTION_MODIFIER, batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES } = {}
) {
  let deleted = 0;
  let batches = 0;

  for (; batches < maxBatches; batches++) {
    const { results } = await db
      .prepare(
        `SELECT id FROM messages WHERE timestamp < ${CUTOFF_EXPR} ORDER BY timestamp LIMIT ?`
      )
      .bind(modifier, batchSize)
      .all();

    if (!results || results.length === 0) break;

    const ids = results.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');

    await db.batch([
      db.prepare(`DELETE FROM message_tags WHERE message_id IN (${placeholders})`).bind(...ids),
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...ids),
    ]);

    deleted += ids.length;
    if (ids.length < batchSize) {
      batches++;
      break;
    }
  }

  // True when we stopped on the batch cap rather than because we were done, so
  // the next run has more to do. Surfaced instead of silently truncating.
  const exhausted = batches >= maxBatches && (await countExpiredMessages(db, modifier)) > 0;

  if (deleted > 0 || exhausted) {
    console.log(
      `[retention] deleted ${deleted} messages older than ${modifier} in ${batches} batch(es)` +
        (exhausted ? ' — batch cap hit, more remain for the next run' : '')
    );
  }

  return { deleted, batches, exhausted };
}
