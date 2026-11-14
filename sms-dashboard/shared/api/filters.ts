import * as v from 'valibot';

/** Rule kinds allowed in filter_rules.rule_type. */
export const RULE_TYPE = {
  /** Substring match against the message body. */
  BODY_KEYWORD: 'body_keyword',
  /** Exact match against the sender's number. */
  SENDER: 'sender',
} as const;

export type RuleType = (typeof RULE_TYPE)[keyof typeof RULE_TYPE];

/** A filter_rules row, every column. */
export const FilterRule = v.object({
  id: v.number(),
  rule_type: v.picklist(Object.values(RULE_TYPE)),
  pattern: v.string(),
  note: v.nullable(v.string()),
  is_active: v.number(),
  created_by: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

export type FilterRule = v.InferOutput<typeof FilterRule>;

/** GET /api/filters. */
export const FiltersResponse = v.object({ filters: v.array(FilterRule) });

export type FiltersResponse = v.InferOutput<typeof FiltersResponse>;

/** POST /api/filters and PUT /api/filters/:id. */
export const FilterResponse = v.object({ filter: FilterRule });

export type FilterResponse = v.InferOutput<typeof FilterResponse>;
