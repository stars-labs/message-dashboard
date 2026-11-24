import {
  listHistoryMessages,
  updateMessageVerdicts,
  type HistoryRow,
  type MessageVerdict,
} from '../db/filters.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { RULE_TYPE } from '../../shared/api/filters.js';
import type { HistoryCursor, RuleHistoryPage } from '../../shared/api/history.js';
import { classifyMessage, FILTER_STATUS, loadActiveRules } from './spam-filter.js';
import type { SpamRule } from './spam-filter.js';

const FILTER_HISTORY_PAGE_SIZE = 200;

export interface HistoryRule extends SpamRule {
  is_active: number | boolean;
}

function historyCursor(row: HistoryRow): HistoryCursor {
  return { created_at: row.created_at, id: row.id };
}

/** Rule mutations never call this; an operator requests every page. */
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
      // Over-inclusive on purpose; classifyMessage below decides, including country prefixes.
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
  const results = await listHistoryMessages(db, conditions, params, limit + 1);

  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  if (page.length === 0) {
    return { mode, processed: 0, changed: 0, has_more: false, next_cursor: null };
  }

  const activeRules = await loadActiveRules(db);
  const changed: MessageVerdict[] = [];

  for (const message of page) {
    const verdict = classifyMessage(message, activeRules);
    if (
      verdict.filter_status === message.filter_status &&
      verdict.filter_rule_id === message.filter_rule_id
    )
      continue;

    changed.push({
      id: message.id,
      filter_status: verdict.filter_status,
      filter_rule_id: verdict.filter_rule_id,
    });
  }

  await updateMessageVerdicts(db, changed);

  const last = page.at(-1);
  return {
    mode,
    processed: page.length,
    changed: changed.length,
    has_more: hasMore,
    next_cursor: hasMore && last ? historyCursor(last) : null,
  };
}
