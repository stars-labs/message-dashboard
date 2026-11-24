import * as v from 'valibot';
import { bodyObject } from './body.js';

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

const RULE_TYPE_MESSAGE = `rule_type must be one of: ${Object.values(RULE_TYPE).join(', ')}`;
/** Also the answer to a pattern that is only whitespace. */
export const PATTERN_MESSAGE = 'pattern is required';
const NOTE_MESSAGE = 'note must be a string';
const ACTIVE_MESSAGE = 'is_active must be true or false';
export const IMMUTABLE_RULE_MESSAGE =
  'Rule type and pattern are immutable; create a new rule instead';

/** POST /api/filters. */
export const CreateFilterBody = bodyObject(
  {
    rule_type: v.picklist(Object.values(RULE_TYPE), RULE_TYPE_MESSAGE),
    pattern: v.string(PATTERN_MESSAGE),
    note: v.nullish(v.string(NOTE_MESSAGE)),
  },
  { rule_type: RULE_TYPE_MESSAGE, pattern: PATTERN_MESSAGE },
);

/** PUT /api/filters/:id. Only the note and is_active may change. */
export const UpdateFilterBody = bodyObject(
  {
    rule_type: v.optional(v.string(IMMUTABLE_RULE_MESSAGE)),
    pattern: v.optional(v.string(IMMUTABLE_RULE_MESSAGE)),
    note: v.nullish(v.string(NOTE_MESSAGE)),
    is_active: v.optional(v.boolean(ACTIVE_MESSAGE)),
  },
  {},
);
