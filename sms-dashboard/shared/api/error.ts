import * as v from 'valibot';

export const ErrorResponse = v.object({
  success: v.optional(v.literal(false)),
  error: v.string(),
  detail: v.optional(v.string()),
});

export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;
