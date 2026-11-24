// 'pending' is the cursor: a sweep that runs out of time just stops, and the next
// call resumes where it left off.

import type { D1, D1Batch } from '../lib/d1.js';
import {
  countMessagesByFilterStatus,
  listMessagesByFilterStatus,
  updateMessageFilterVerdicts,
} from '../db/messages.js';
import { classifyMessage, loadActiveRules, FILTER_STATUS } from './spam-filter.js';

/** Also the D1 batch size. */
const PAGE_SIZE = 200;

const DEFAULT_BUDGET_MS = 20_000;

export function countPending(db: D1<'first'>): Promise<number> {
  return countMessagesByFilterStatus(db, FILTER_STATUS.PENDING);
}

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

    if (results.length < pageSize) break;
  }

  const remaining = await countPending(db);
  console.log(`[spam-backfill] swept ${processed}, ${remaining} still pending`);
  return { processed, remaining };
}
