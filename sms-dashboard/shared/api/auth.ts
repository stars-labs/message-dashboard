import * as v from 'valibot';

export const SessionUser = v.object({
  id: v.string(),
  sub: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
  picture: v.optional(v.string()),
  provider: v.optional(v.string()),
  roles: v.array(v.string()),
});

export type SessionUser = v.InferOutput<typeof SessionUser>;

export const MeResponse = v.object({
  success: v.literal(true),
  user: v.object({ ...SessionUser.entries, permissions: v.array(v.string()) }),
});

export type MeResponse = v.InferOutput<typeof MeResponse>;
