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

import type { D1, D1Batch } from '../lib/d1.js';
import {
  countMessagesByFilterStatus,
  listMessagesByFilterStatus,
  updateMessageFilterVerdicts,
} from '../db/messages.js';
import { classifyMessage, loadActiveRules, FILTER_STATUS } from './spam-filter.js';

/** Rows fetched and updated per iteration. Also the D1 batch size. */
const PAGE_SIZE = 200;

/** Stop starting new pages after this long, to stay inside the Worker's budget. */
const DEFAULT_BUDGET_MS = 20_000;

/** How many messages are still waiting to be judged. */
export function countPending(db: D1<'first'>): Promise<number> {
  return countMessagesByFilterStatus(db, FILTER_STATUS.PENDING);
}

/**
 * Judge messages currently marked 'pending', in bounded pages.
 */
export async function sweepPending(
  db: D1<'all' | 'first' | 'run'> & D1Batch<'all' | 'first' | 'run'>,
  {
    pageSize = PAGE_SIZE,
    budgetMs = DEFAULT_BUDGET_MS,
  }: { pageSize?: number; budgetMs?: number } = {},
): Promise<{ processed: number; remaining: number }> {
  const rules = await loadActiveRules(db);
  const startedAt = Date.now();
  let processed = 0;

  while (Date.now() - startedAt < budgetMs) {
    const results = await listMessagesByFilterStatus(db, FILTER_STATUS.PENDING, pageSize);

    if (results.length === 0) break;

    await updateMessageFilterVerdicts(
      db,
      results.map((row) => {
        const verdict = classifyMessage(row, rules);
        return {
          id: row.id,
          filterStatus: verdict.filter_status,
          filterRuleId: verdict.filter_rule_id,
        };
      }),
    );

    processed += results.length;

    // Short page means we drained the queue.
    if (results.length < pageSize) break;
  }

  const remaining = await countPending(db);
  console.log(`[spam-backfill] swept ${processed}, ${remaining} still pending`);
  return { processed, remaining };
}
