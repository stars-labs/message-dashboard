import * as v from 'valibot';

/** A batch query and how far its checks have got. */
export const BalanceBatch = v.object({
  id: v.string(),
  requested_by_subject: v.nullable(v.string()),
  created_at: v.string(),
  cancelled_at: v.nullable(v.string()),
  total: v.number(),
  parsed: v.number(),
  /** Failed, timed out, or answered with a reply nobody could read. */
  failed: v.number(),
  cancelled: v.number(),
  in_progress: v.number(),
  /** Queued checks whose SMS the daemon or whose job a runner has not taken yet. */
  cancellable: v.number(),
});

export type BalanceBatch = v.InferOutput<typeof BalanceBatch>;

export const BalanceBatchesResponse = v.object({
  success: v.literal(true),
  batches: v.array(BalanceBatch),
});

export type BalanceBatchesResponse = v.InferOutput<typeof BalanceBatchesResponse>;

export const BalanceBatchResponse = v.object({ success: v.literal(true), batch: BalanceBatch });

export type BalanceBatchResponse = v.InferOutput<typeof BalanceBatchResponse>;

export const BalanceBatchCancelResponse = v.object({
  success: v.literal(true),
  cancelled: v.number(),
  batch: BalanceBatch,
});

export type BalanceBatchCancelResponse = v.InferOutput<typeof BalanceBatchCancelResponse>;
