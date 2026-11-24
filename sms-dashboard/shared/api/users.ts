import * as v from 'valibot';

export const ManagedUser = v.object({
  id: v.string(),
  email: v.nullable(v.string()),
  name: v.nullable(v.string()),
  last_login: v.nullable(v.string()),
  logins_count: v.number(),
  roles: v.array(v.string()),
  role: v.nullable(v.string()),
});

export type ManagedUser = v.InferOutput<typeof ManagedUser>;

/** Role names are deployment config, so the server names which is which. */
export const UsersResponse = v.object({
  success: v.literal(true),
  users: v.array(ManagedUser),
  known_roles: v.array(v.string()),
  admin_role: v.string(),
  viewer_role: v.string(),
});

export type UsersResponse = v.InferOutput<typeof UsersResponse>;

export const SetRoleResponse = v.object({
  success: v.literal(true),
  user_id: v.string(),
  role: v.string(),
  previous_roles: v.array(v.string()),
  sessions_revoked: v.number(),
});

export type SetRoleResponse = v.InferOutput<typeof SetRoleResponse>;
