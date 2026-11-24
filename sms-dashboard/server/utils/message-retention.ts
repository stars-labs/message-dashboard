import type { D1, D1Batch } from '../lib/d1.js';
import {
  countExpiredMessages as countExpiredMessagesBefore,
  deleteMessagesAndTags,
  listExpiredMessageIds,
} from '../db/messages.js';

const RETENTION_MODIFIER = '-12 months';

/** Also the bound-parameter count per statement; stays under SQLite's variable limit. */
const BATCH_SIZE = 200;

const MAX_BATCHES = 50;

export async function countExpiredMessages(
  db: D1<'first'>,
  modifier: string = RETENTION_MODIFIER,
): Promise<number> {
  return countExpiredMessagesBefore(db, modifier);
}

/**
 * Deletes by id list (`DELETE ... LIMIT` needs a SQLite compile-time option) and
 * removes message_tags in the same batch (foreign keys may not be enforced).
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

  // Stopped on the batch cap, not because the backlog is empty.
  const exhausted = batches >= maxBatches && (await countExpiredMessages(db, modifier)) > 0;

  if (deleted > 0 || exhausted) {
    console.log(
      `[retention] deleted ${deleted} messages older than ${modifier} in ${batches} batch(es)` +
        (exhausted ? ' — batch cap hit, more remain for the next run' : ''),
    );
  }

  return { deleted, batches, exhausted };
}
