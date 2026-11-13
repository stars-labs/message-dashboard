// Role-Based Access Control middleware, backed by Auth0 roles.
//
// This gate fails CLOSED. It previously keyed off `env.USE_AUTH0_ROLES !== 'false'`,
// which meant a missing, misspelled or unexpected value silently disabled every
// permission check — and production shipped with the flag set to "false", so every
// authenticated user held every permission. There is deliberately no longer any
// environment switch that can turn authorization off; see docs/SECURITY-REVIEW.md
// findings 1 and 5.
//
// The role -> permission table lives in config/auth0-roles.ts.

import { createRoleConfig, getKnownRoles, permissionsForRoles } from '../../config/auth0-roles.js';
import type { Permission, RoleEnv } from '../../config/auth0-roles.js';

export interface PermissionRequest {
  user?: { roles?: unknown; permissions?: string[] };
  env: RoleEnv;
}

function forbidden(message: string): Response {
  return new Response(JSON.stringify({ error: 'Forbidden', message }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build the gate for one permission. It returns a Response to short-circuit the
 * route, or undefined to let it proceed. A permission the role table does not
 * grant is denied, so the gate fails closed.
 */
export function requirePermission(
  permission: Permission,
): (request: PermissionRequest) => Response | undefined {
  return (request) => {
    const { user, env } = request;

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
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

/**
 * Attach the caller's effective permissions, which is also what /api/auth/me returns so
 * the client can hide controls it may not use.
 *
 * Defaults to none and only ever grows on an explicit positive role match — the version
 * before the security review had an else-branch that handed out the full permission set
 * when role checking was disabled.
 */
export function enrichUserPermissions(request: PermissionRequest): void {
  const { user, env } = request;

  if (!user) return;

  user.permissions = permissionsForRoles(user.roles, createRoleConfig(env));
}
