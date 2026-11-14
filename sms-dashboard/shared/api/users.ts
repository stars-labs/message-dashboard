import * as v from 'valibot';

/** A tenant user with the one app role they hold, if any. */
const ManagedUser = v.object({
  id: v.string(),
  email: v.nullable(v.string()),
  name: v.nullable(v.string()),
  last_login: v.nullable(v.string()),
  logins_count: v.number(),
  roles: v.array(v.string()),
  role: v.nullable(v.string()),
});

/** GET /api/users. Role names are deployment config, so the server names which is which. */
export const UsersResponse = v.object({
  success: v.literal(true),
  users: v.array(ManagedUser),
  known_roles: v.array(v.string()),
  admin_role: v.string(),
  viewer_role: v.string(),
});

export type UsersResponse = v.InferOutput<typeof UsersResponse>;

/** PUT /api/users/:id/role. */
export const SetRoleResponse = v.object({
  success: v.literal(true),
  user_id: v.string(),
  role: v.string(),
  previous_roles: v.array(v.string()),
  sessions_revoked: v.number(),
});

export type SetRoleResponse = v.InferOutput<typeof SetRoleResponse>;
