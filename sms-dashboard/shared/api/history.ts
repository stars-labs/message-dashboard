import * as v from 'valibot';

/** Keyset cursor for the next page of a history run. */
export const HistoryCursor = v.object({ created_at: v.string(), id: v.string() });

export type HistoryCursor = v.InferOutput<typeof HistoryCursor>;

/** POST /api/filters/:id/history: one page of applying or releasing a rule. */
export const RuleHistoryPage = v.object({
  mode: v.picklist(['apply', 'release']),
  processed: v.number(),
  changed: v.number(),
  has_more: v.boolean(),
  next_cursor: v.nullable(HistoryCursor),
});

export type RuleHistoryPage = v.InferOutput<typeof RuleHistoryPage>;

/** POST /api/keywords/:id/history: one page of tagging history with a keyword. */
export const KeywordHistoryPage = v.object({
  processed: v.number(),
  eligible: v.number(),
  matched_messages: v.number(),
  inserted: v.number(),
  has_more: v.boolean(),
  next_cursor: v.nullable(HistoryCursor),
});

export type KeywordHistoryPage = v.InferOutput<typeof KeywordHistoryPage>;
