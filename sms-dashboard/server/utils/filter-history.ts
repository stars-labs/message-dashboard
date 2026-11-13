import * as v from 'valibot';
import { queryAll, type D1, type D1Batch, type D1Statement } from '../lib/d1.js';
import { classifyMessage, FILTER_STATUS, loadActiveRules, RULE_TYPE } from './spam-filter.js';
import type { SpamRule } from './spam-filter.js';

export const FILTER_HISTORY_PAGE_SIZE = 200;

/** Keyset cursor for the next page. */
export interface HistoryCursor {
  created_at: string;
  id: string;
}

/** A rule as processRuleHistoryPage reads it. */
export interface HistoryRule extends SpamRule {
  is_active: number | boolean;
}

/** One message row the page scans. */
const HistoryRow = v.object({
  id: v.string(),
  type: v.string(),
  content: v.string(),
  phone_number: v.nullable(v.string()),
  filter_status: v.string(),
  filter_rule_id: v.nullable(v.number()),
  created_at: v.string(),
});

type HistoryRow = v.InferOutput<typeof HistoryRow>;

export interface RuleHistoryPage {
  mode: 'apply' | 'release';
  processed: number;
  changed: number;
  has_more: boolean;
  next_cursor: HistoryCursor | null;
}

function historyCursor(row: HistoryRow): HistoryCursor {
  return { created_at: row.created_at, id: row.id };
}

/**
 * Explicitly apply or release one rule over one bounded slice of history.
 * Rule mutations never call this function; an operator must request every page.
 */
export async function processRuleHistoryPage(
  db: D1<'all' | 'run'> & D1Batch<'all' | 'run'>,
  rule: HistoryRule,
  {
    since,
    until,
    cursor = null,
    pageSize = FILTER_HISTORY_PAGE_SIZE,
  }: {
    since: string;
    until: string;
    cursor?: HistoryCursor | null;
    pageSize?: unknown;
  },
): Promise<RuleHistoryPage> {
  const mode = rule.is_active ? 'apply' : 'release';
  const conditions = [
    `created_at >= datetime(?)`,
    `created_at <= datetime(?)`,
    `type = 'received'`,
    `purpose = 'user'`,
  ];
  const params: unknown[] = [since, until];

  if (cursor) {
    conditions.push(`(created_at > ? OR (created_at = ? AND id > ?))`);
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }

  if (mode === 'apply') {
    conditions.push(`verification_code IS NULL`);
    conditions.push(`filter_status <> '${FILTER_STATUS.FILTERED}'`);

    if (rule.rule_type === RULE_TYPE.BODY_KEYWORD) {
      conditions.push(`instr(content, ?) > 0`);
      params.push(rule.pattern);
    } else {
      // This is deliberately an over-inclusive candidate search. The canonical
      // classifier below makes the final decision, including country prefixes.
      conditions.push(`phone_number LIKE '%' || ? || '%'`);
      params.push(rule.pattern);
    }
  } else {
    conditions.push(`filter_rule_id = ?`);
    params.push(rule.id);
  }

  const limit = Math.max(
    1,
    Math.min(Number(pageSize) || FILTER_HISTORY_PAGE_SIZE, FILTER_HISTORY_PAGE_SIZE),
  );
  const results = await queryAll(
    db
      .prepare(
        `SELECT id, type, content, phone_number, filter_status, filter_rule_id, created_at
     FROM messages
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY created_at, id
     LIMIT ?`,
      )
      .bind(...params, limit + 1),
    HistoryRow,
  );

  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  if (page.length === 0) {
    return { mode, processed: 0, changed: 0, has_more: false, next_cursor: null };
  }

  const activeRules = await loadActiveRules(db);
  const changed: D1Statement<'all' | 'run'>[] = [];

  for (const message of page) {
    const verdict = classifyMessage(message, activeRules);
    if (
      verdict.filter_status === message.filter_status &&
      verdict.filter_rule_id === message.filter_rule_id
    )
      continue;

    changed.push(
      db
        .prepare(
          `UPDATE messages
       SET filter_status = ?, filter_rule_id = ?
       WHERE id = ?`,
        )
        .bind(verdict.filter_status, verdict.filter_rule_id, message.id),
    );
  }

  if (changed.length > 0) await db.batch(changed);

  const last = page.at(-1);
  return {
    mode,
    processed: page.length,
    changed: changed.length,
    has_more: hasMore,
    next_cursor: hasMore && last ? historyCursor(last) : null,
  };
}
