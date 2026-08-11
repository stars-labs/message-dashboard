import { extractVerificationCode } from './verification.js';
import { FILTER_STATUS } from './spam-filter.js';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const SAMPLE_LIMIT = 12;

function normaliseCode(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Recalculate one bounded page of stored verification codes.
 *
 * The caller owns the cursor and passes next_cursor into the next request. This
 * keeps the operation stateless, resumable, and within a Worker's request budget.
 */
export async function reprocessVerificationPage(
  db,
  { after = 0, pageSize = DEFAULT_PAGE_SIZE, dryRun = false } = {}
) {
  const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
  const boundedPageSize = Math.min(
    Math.max(Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );

  const { results = [] } = await db
    .prepare(
      `SELECT rowid AS row_cursor, id, content, verification_code
       FROM messages
       WHERE rowid > ? AND type = 'received'
       ORDER BY rowid
       LIMIT ?`
    )
    .bind(cursor, boundedPageSize)
    .all();

  const changes = [];
  for (const row of results) {
    const previous = normaliseCode(row.verification_code);
    const next = extractVerificationCode(row.content);
    if (previous !== next) {
      changes.push({ id: row.id, previous, next });
    }
  }

  if (!dryRun && changes.length > 0) {
    const update = db.prepare(
      `UPDATE messages
       SET verification_code = ?, filter_status = ?, filter_rule_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );
    await db.batch(
      changes.map((change) =>
        update.bind(change.next, FILTER_STATUS.PENDING, change.id)
      )
    );
  }

  const lastRow = results.at(-1);
  return {
    processed: results.length,
    changed: changes.length,
    removed: changes.filter((change) => change.previous && !change.next).length,
    added: changes.filter((change) => !change.previous && change.next).length,
    replaced: changes.filter((change) => change.previous && change.next).length,
    next_cursor: lastRow?.row_cursor ?? cursor,
    done: results.length < boundedPageSize,
    dry_run: Boolean(dryRun),
    samples: changes.slice(0, SAMPLE_LIMIT),
  };
}
