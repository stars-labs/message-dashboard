// Fails closed: no environment switch can turn authorization off.
// The role -> permission table lives in config/auth0-roles.ts.

import { createRoleConfig, getKnownRoles, permissionsForRoles } from '../../config/auth0-roles.js';
import type { Permission, RoleEnv } from '../../config/auth0-roles.js';
import { json } from '../lib/response.js';

export interface PermissionRequest {
  user?: { roles?: unknown; permissions?: string[] };
  env: RoleEnv;
}

function forbidden(message: string): Response {
  return json({ error: 'Forbidden', message }, 403);
}

// Returns a Response to short-circuit the route, or undefined to let it proceed.
export function requirePermission(
  permission: Permission,
): (request: PermissionRequest) => Response | undefined {
  return (request) => {
    const { user, env } = request;

    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const roleConfig = createRoleConfig(env);
    const granted = permissionsForRoles(user.roles, roleConfig);

    if (!granted.includes(permission)) {
      return forbidden(
        granted.length === 0
          ? `You need one of these roles to access this system: ${getKnownRoles(roleConfig).join(', ')}`
          : `Your role does not grant '${permission}'`,
      );
    }

    return undefined;
  };
}

// Also what /api/auth/me returns so the client can hide controls. Defaults to none.
export function enrichUserPermissions(request: PermissionRequest): void {
  const { user, env } = request;

  if (!user) return;

  user.permissions = permissionsForRoles(user.roles, createRoleConfig(env));
}
