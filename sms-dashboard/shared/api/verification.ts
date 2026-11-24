import * as v from 'valibot';

/**
 * POST /api/verification/reprocess query: the page after `after`, of `limit`
 * messages, written only when `dry_run` is not "1". The server bounds and
 * coerces the values.
 */
export const ReprocessQuery = v.object({
  after: v.optional(v.string()),
  limit: v.optional(v.string()),
  dry_run: v.optional(v.string()),
});

/** One code a page would change, before and after. */
const CodeChange = v.object({
  id: v.string(),
  previous: v.nullable(v.string()),
  next: v.nullable(v.string()),
});

/** POST /api/verification/reprocess: one page re-extracted, and the spam sweep it triggered. */
export const ReprocessResponse = v.object({
  success: v.literal(true),
  processed: v.number(),
  changed: v.number(),
  removed: v.number(),
  added: v.number(),
  replaced: v.number(),
  next_cursor: v.number(),
  done: v.boolean(),
  dry_run: v.boolean(),
  samples: v.array(CodeChange),
  filter_sweep: v.nullable(v.object({ processed: v.number(), remaining: v.number() })),
});

export type ReprocessResponse = v.InferOutput<typeof ReprocessResponse>;
