import * as v from 'valibot';

/**
 * One exchange on a /api/control/ route as the Pi daemon or the Balance Agent
 * performs it today. The Worker must answer the request with exactly this
 * response, and each client must send the body and read the answer, so a
 * change on either side fails a test. A response without a body has none.
 */
export const ControlFixture = v.strictObject({
  request: v.strictObject({
    method: v.picklist(['GET', 'POST', 'DELETE']),
    path: v.string(),
    body: v.optional(v.unknown()),
  }),
  response: v.strictObject({
    status: v.number(),
    body: v.optional(v.unknown()),
  }),
});

export type ControlFixture = v.InferOutput<typeof ControlFixture>;
