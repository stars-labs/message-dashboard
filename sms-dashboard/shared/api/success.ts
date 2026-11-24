import * as v from 'valibot';

export const SuccessResponse = v.object({ success: v.literal(true) });

export type SuccessResponse = v.InferOutput<typeof SuccessResponse>;
