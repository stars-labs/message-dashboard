import * as v from 'valibot';
import { bodyObject } from './body.js';

export const HistoryCursor = v.object({ created_at: v.string(), id: v.string() });

export type HistoryCursor = v.InferOutput<typeof HistoryCursor>;

export const RuleHistoryPage = v.object({
  mode: v.picklist(['apply', 'release']),
  processed: v.number(),
  changed: v.number(),
  has_more: v.boolean(),
  next_cursor: v.nullable(HistoryCursor),
});

export type RuleHistoryPage = v.InferOutput<typeof RuleHistoryPage>;

export const KeywordHistoryPage = v.object({
  processed: v.number(),
  eligible: v.number(),
  matched_messages: v.number(),
  inserted: v.number(),
  has_more: v.boolean(),
  next_cursor: v.nullable(HistoryCursor),
});

export type KeywordHistoryPage = v.InferOutput<typeof KeywordHistoryPage>;

const RANGE_MESSAGE = 'A valid history time range is required';
const CURSOR_MESSAGE = 'Invalid history cursor';

const Instant = v.pipe(
  v.union([v.string(RANGE_MESSAGE), v.number(RANGE_MESSAGE)], RANGE_MESSAGE),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), RANGE_MESSAGE),
);

const HistoryCursorBody = v.object(
  {
    created_at: v.pipe(
      v.string(CURSOR_MESSAGE),
      v.check((value) => !Number.isNaN(new Date(`${value}Z`).getTime()), CURSOR_MESSAGE),
    ),
    id: v.string(CURSOR_MESSAGE),
  },
  CURSOR_MESSAGE,
) satisfies v.GenericSchema<unknown, HistoryCursor>;

export const HistoryRequestBody = v.pipe(
  bodyObject(
    { since: Instant, until: Instant, cursor: v.nullish(HistoryCursorBody) },
    { since: RANGE_MESSAGE, until: RANGE_MESSAGE },
  ),
  v.check(({ since, until }) => since <= until, RANGE_MESSAGE),
);
