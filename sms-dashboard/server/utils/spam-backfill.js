// Re-applying spam rules to messages that already exist.
//
// Design: 'pending' IS the cursor. Anything that needs (re)judging is marked
// pending, then swept in bounded pages. If a sweep runs out of time it simply
// stops — the next call, whether from the API or the nightly cron, picks up
// exactly where it left off. No progress table, no resume token.
//
// SQL is only ever used to NARROW candidates, never to decide. A pre-filter that
// selects too much is harmless because classifyMessage() has the final say; one
// that selects too little would silently leave messages misjudged, so the
// pre-filters below deliberately err toward over-selecting.

import { classifyMessage, loadActiveRules, FILTER_STATUS } from './spam-filter.js';

/** Rows fetched and updated per iteration. Also the D1 batch size. */
const PAGE_SIZE = 200;

/** Stop starting new pages after this long, to stay inside the Worker's budget. */
const DEFAULT_BUDGET_MS = 20_000;

/** How many messages are still waiting to be judged. */
export async function countPending(db) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE filter_status = ?`)
    .bind(FILTER_STATUS.PENDING)
    .first();
  return row?.n ?? 0;
}

/**
 * Judge messages currently marked 'pending', in bounded pages.
 *
 * @returns {Promise<{processed: number, remaining: number}>}
 */
export async function sweepPending(db, { pageSize = PAGE_SIZE, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const rules = await loadActiveRules(db);
  const startedAt = Date.now();
  let processed = 0;

  while (Date.now() - startedAt < budgetMs) {
    const { results } = await db
      .prepare(
        `SELECT id, type, content, phone_number
         FROM messages
         WHERE filter_status = ?
         ORDER BY rowid
         LIMIT ?`
      )
      .bind(FILTER_STATUS.PENDING, pageSize)
      .all();

    if (!results || results.length === 0) break;

    const update = db.prepare(
      `UPDATE messages SET filter_status = ?, filter_rule_id = ? WHERE id = ?`
    );

    // One bound statement per row. Do NOT try to bind many rows onto a single
    // "WHERE id = ?" statement — the parameter count would not match.
    await db.batch(
      results.map((row) => {
        const verdict = classifyMessage(row, rules);
        return update.bind(verdict.filter_status, verdict.filter_rule_id, row.id);
      })
    );

    processed += results.length;

    // Short page means we drained the queue.
    if (results.length < pageSize) break;
  }

  const remaining = await countPending(db);
  console.log(`[spam-backfill] swept ${processed}, ${remaining} still pending`);
  return { processed, remaining };
}
