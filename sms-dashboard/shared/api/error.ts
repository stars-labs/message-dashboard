import * as v from 'valibot';

/** What the server answers when it refuses or fails a request; `detail` says why, when known. */
export const ErrorResponse = v.object({
  success: v.optional(v.literal(false)),
  error: v.string(),
  detail: v.optional(v.string()),
});

export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;
