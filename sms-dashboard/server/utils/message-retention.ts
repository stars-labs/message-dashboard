// Message retention: everything is kept for 12 months, then deleted.
//
// Applies to received and sent alike, filtered or not. Spam is retained just as
// long as anything else, so a rule that turns out to be wrong can still be
// audited months later.

import type { D1, D1Batch } from '../lib/d1.js';
import {
  countExpiredMessages as countExpiredMessagesBefore,
  deleteMessagesAndTags,
  listExpiredMessageIds,
} from '../db/messages.js';

/** SQLite date modifier defining the retention window. */
const RETENTION_MODIFIER = '-12 months';

/**
 * Rows per batch. Also the bound-parameter count per statement, kept well under
 * SQLite's variable limit.
 */
const BATCH_SIZE = 200;

/** Safety stop, so a bug cannot turn into an unbounded delete loop. */
const MAX_BATCHES = 50;

/** How many messages are currently past the retention window. */
export async function countExpiredMessages(
  db: D1<'first'>,
  modifier: string = RETENTION_MODIFIER,
): Promise<number> {
  return countExpiredMessagesBefore(db, modifier);
}

/**
 * Delete messages older than the retention window, in bounded batches.
 *
 * Deletes by explicit id list rather than `DELETE ... LIMIT`, which depends on a
 * SQLite compile-time option, and removes each message's keyword tags in the same
 * batch rather than relying on ON DELETE CASCADE — foreign key enforcement is not
 * guaranteed to be on, and orphaned message_tags rows would accumulate silently.
 */
export async function purgeExpiredMessages(
  db: D1<'all' | 'first'> & D1Batch<'all' | 'first'>,
  {
    modifier = RETENTION_MODIFIER,
    batchSize = BATCH_SIZE,
    maxBatches = MAX_BATCHES,
  }: {
    modifier?: string;
    batchSize?: number;
    maxBatches?: number;
  } = {},
): Promise<{ deleted: number; batches: number; exhausted: boolean }> {
  let deleted = 0;
  let batches = 0;

  for (; batches < maxBatches; batches++) {
    const ids = await listExpiredMessageIds(db, modifier, batchSize);

    if (ids.length === 0) break;

    await deleteMessagesAndTags(db, ids);

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
        (exhausted ? ' — batch cap hit, more remain for the next run' : ''),
    );
  }

  return { deleted, batches, exhausted };
}
