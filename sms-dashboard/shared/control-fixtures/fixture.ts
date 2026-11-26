import * as v from 'valibot';

/**
 * One exchange on a /api/control/ route: the Worker must answer exactly this, and each
 * client must send the body and read the answer. A request carries the API key unless it
 * is `anonymous`; `text` is a body sent as is, for requests that are not JSON.
 */
export const ControlFixture = v.strictObject({
  request: v.strictObject({
    method: v.picklist(['GET', 'POST', 'DELETE']),
    path: v.string(),
    body: v.optional(v.unknown()),
    text: v.optional(v.string()),
    anonymous: v.optional(v.literal(true)),
  }),
  response: v.strictObject({
    status: v.number(),
    /** Present on a recurring call's answer: how long to wait before the next one (ADR 0002). */
    headers: v.optional(v.strictObject({ 'X-Poll-Interval': v.string() })),
    body: v.optional(v.unknown()),
  }),
});

export type ControlFixture = v.InferOutput<typeof ControlFixture>;
