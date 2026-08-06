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

import { classifyMessage, loadActiveRules, FILTER_STATUS, RULE_TYPE } from './spam-filter.js';

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

/**
 * Queue every message a given rule could newly apply to.
 *
 * Only rows that are not already filtered are touched: a row filtered by an
 * earlier-numbered rule keeps that attribution.
 */
export async function markPendingForRule(db, rule) {
  if (!rule || !rule.pattern) return 0;

  let result;
  if (rule.rule_type === RULE_TYPE.BODY_KEYWORD) {
    // instr() is an exact substring test, matching the classifier's includes().
    result = await db
      .prepare(
        `UPDATE messages SET filter_status = ?
         WHERE filter_status <> ? AND instr(content, ?) > 0`
      )
      .bind(FILTER_STATUS.PENDING, FILTER_STATUS.FILTERED, rule.pattern)
      .run();
  } else if (rule.rule_type === RULE_TYPE.SENDER) {
    // Deliberately loose: a substring test also catches '+8610086' and, harmlessly,
    // '13910086'. The classifier rejects the latter. A stricter SQL comparison
    // risked MISSING punctuated numbers, which would be the damaging direction.
    result = await db
      .prepare(
        `UPDATE messages SET filter_status = ?
         WHERE filter_status <> ? AND phone_number LIKE '%' || ? || '%'`
      )
      .bind(FILTER_STATUS.PENDING, FILTER_STATUS.FILTERED, rule.pattern)
      .run();
  } else {
    return 0;
  }

  return result?.meta?.changes ?? 0;
}

/**
 * Release every message a rule is currently hiding, so it can be re-judged
 * against the remaining rules — it may well match a different one.
 *
 * Must run BEFORE the rule row is deleted: the FK is ON DELETE SET NULL, so
 * deleting first would erase the attribution and leave rows filtered with no
 * recoverable reason.
 */
export async function releaseRowsAttributedTo(db, ruleId) {
  const result = await db
    .prepare(
      `UPDATE messages SET filter_status = ?, filter_rule_id = NULL WHERE filter_rule_id = ?`
    )
    .bind(FILTER_STATUS.PENDING, ruleId)
    .run();
  return result?.meta?.changes ?? 0;
}

/** Queue the entire table for re-judgement. */
export async function markAllPending(db) {
  const result = await db
    .prepare(`UPDATE messages SET filter_status = ?, filter_rule_id = NULL`)
    .bind(FILTER_STATUS.PENDING)
    .run();
  return result?.meta?.changes ?? 0;
}
