import * as v from 'valibot';

/** The answer of a route that reports nothing but success, such as a DELETE. */
export const SuccessResponse = v.object({ success: v.literal(true) });

export type SuccessResponse = v.InferOutput<typeof SuccessResponse>;
