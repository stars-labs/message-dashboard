import * as v from 'valibot';

/** The user the login callback stores in the session and the middleware attaches to requests. */
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

/** GET /api/auth/me: the signed-in user with the permissions their roles grant. */
export const MeResponse = v.object({
  success: v.literal(true),
  user: v.object({ ...SessionUser.entries, permissions: v.array(v.string()) }),
});

export type MeResponse = v.InferOutput<typeof MeResponse>;
