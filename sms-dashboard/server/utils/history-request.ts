import * as v from 'valibot';
import { OBJECT_MESSAGE, type MissingKeyMessages } from '../lib/request-body.js';
import type { HistoryCursor } from './filter-history.js';

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

/** Body of the one-page-at-a-time history routes for filter rules and keywords. */
export const HistoryRequestBody = v.pipe(
  v.object(
    { since: Instant, until: Instant, cursor: v.nullish(HistoryCursorBody) },
    OBJECT_MESSAGE,
  ),
  v.check(({ since, until }) => since <= until, RANGE_MESSAGE),
);

export const HISTORY_MISSING_KEY_MESSAGES = {
  since: RANGE_MESSAGE,
  until: RANGE_MESSAGE,
} as const satisfies MissingKeyMessages<typeof HistoryRequestBody>;
