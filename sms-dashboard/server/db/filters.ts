import * as v from 'valibot';
import { FilterRule, RULE_TYPE } from '../../shared/api/filters.js';
import { queryAll, queryFirst, queryOne, type D1, type D1Batch } from '../lib/d1.js';

const FILTER_COLUMNS =
  'id, rule_type, pattern, note, is_active, created_by, created_at, updated_at';

const ReferencedRow = v.object({ referenced: v.number() });

/** One active row from filter_rules, whose rule_type the table restricts to the known kinds. */
const SpamRuleRow = v.object({
  id: v.number(),
  rule_type: v.picklist(Object.values(RULE_TYPE)),
  pattern: v.string(),
});

export type SpamRule = v.InferOutput<typeof SpamRuleRow>;

/** One message row a rule history page scans. */
const HistoryRow = v.object({
  id: v.string(),
  type: v.string(),
  content: v.string(),
  phone_number: v.nullable(v.string()),
  filter_status: v.string(),
  filter_rule_id: v.nullable(v.number()),
  created_at: v.string(),
});

export type HistoryRow = v.InferOutput<typeof HistoryRow>;

interface NewFilterRule {
  rule_type: string;
  pattern: string;
  note: string | null;
  created_by: string | null;
}

interface FilterRuleChanges {
  rule_type: string;
  pattern: string;
  note: string | null;
  is_active: number;
}

export interface MessageVerdict {
  id: string;
  filter_status: string;
  filter_rule_id: number | null;
}

export function listFilters(db: D1<'all'>): Promise<FilterRule[]> {
  return queryAll(
    db.prepare(
      `SELECT ${FILTER_COLUMNS}
     FROM filter_rules
     ORDER BY rule_type, id`,
    ),
    FilterRule,
  );
}

export function insertFilter(db: D1<'first'>, rule: NewFilterRule): Promise<FilterRule> {
  return queryOne(
    db
      .prepare(
        `INSERT INTO filter_rules (rule_type, pattern, note, created_by)
         VALUES (?, ?, ?, ?)
         RETURNING ${FILTER_COLUMNS}`,
      )
      .bind(rule.rule_type, rule.pattern, rule.note, rule.created_by),
    FilterRule,
  );
}

export function findFilter(db: D1<'first'>, id: number): Promise<FilterRule | null> {
  return queryFirst(
    db.prepare(`SELECT ${FILTER_COLUMNS} FROM filter_rules WHERE id = ?`).bind(id),
    FilterRule,
  );
}

export function updateFilter(
  db: D1<'first'>,
  id: number,
  changes: FilterRuleChanges,
): Promise<FilterRule | null> {
  return queryFirst(
    db
      .prepare(
        `UPDATE filter_rules
         SET rule_type = ?, pattern = ?, note = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
         RETURNING ${FILTER_COLUMNS}`,
      )
      .bind(changes.rule_type, changes.pattern, changes.note, changes.is_active, id),
    FilterRule,
  );
}

export async function isFilterReferenced(db: D1<'first'>, id: number): Promise<boolean> {
  const referenced = await queryFirst(
    db.prepare(`SELECT 1 AS referenced FROM messages WHERE filter_rule_id = ? LIMIT 1`).bind(id),
    ReferencedRow,
  );
  return referenced !== null;
}

export async function deleteFilter(db: D1<'run'>, id: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM filter_rules WHERE id = ?`).bind(id).run();
  return result.meta.changes;
}

export function listActiveSpamRules(db: D1<'all'>): Promise<SpamRule[]> {
  return queryAll(
    db.prepare(
      `SELECT id, rule_type, pattern
       FROM filter_rules
       WHERE is_active = 1
       ORDER BY id`,
    ),
    SpamRuleRow,
  );
}

export function listHistoryMessages(
  db: D1<'all'>,
  conditions: string[],
  params: unknown[],
  limit: number,
): Promise<HistoryRow[]> {
  return queryAll(
    db
      .prepare(
        `SELECT id, type, content, phone_number, filter_status, filter_rule_id, created_at
     FROM messages
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY created_at, id
     LIMIT ?`,
      )
      .bind(...params, limit),
    HistoryRow,
  );
}

export async function updateMessageVerdicts(
  db: D1<'all' | 'run'> & D1Batch<'all' | 'run'>,
  verdicts: MessageVerdict[],
): Promise<void> {
  if (verdicts.length === 0) return;
  await db.batch(
    verdicts.map((verdict) =>
      db
        .prepare(
          `UPDATE messages
       SET filter_status = ?, filter_rule_id = ?
       WHERE id = ?`,
        )
        .bind(verdict.filter_status, verdict.filter_rule_id, verdict.id),
    ),
  );
}
