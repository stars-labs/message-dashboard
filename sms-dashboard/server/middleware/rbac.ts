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

import {
  ALL_PERMISSIONS,
  createRoleConfig,
  getKnownRoles,
  permissionsForRoles,
} from '../../config/auth0-roles.js';
import type { Permission } from '../../config/auth0-roles.js';
import type { AppRequest, Handler } from '../worker-context.js';

function forbidden(message: string): Response {
  return new Response(JSON.stringify({ error: 'Forbidden', message }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build the gate for one permission. The returned function is a Handler, so it can
 * sit in a route's handler chain and short-circuit with its Response.
 */
export function requirePermission(permission: Permission): Handler {
  return async function (request: AppRequest) {
    const { user, env } = request;

    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // An unrecognised permission is a programming error, not a grant. Denying here
    // means a typo'd or newly added permission fails visibly instead of being waved
    // through, which is what the old `if (smsPermissions.includes(permission))`
    // wrapper did to anything outside the list — `phones.write` among them.
    if (!(ALL_PERMISSIONS as string[]).includes(permission)) {
      return forbidden(`Unknown permission '${permission}'`);
    }

    const roleConfig = createRoleConfig(env || {});
    const granted = permissionsForRoles(user.roles, roleConfig);

    if (!granted.includes(permission)) {
      return forbidden(
        granted.length === 0
          ? `You need one of these roles to access this system: ${getKnownRoles(roleConfig).join(', ')}`
          : `Your role does not grant '${permission}'`,
      );
    }

    return; // Allowed.
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
export async function enrichUserPermissions(request: AppRequest): Promise<void> {
  const { user, env } = request;

  if (!user) return;

  user.permissions = permissionsForRoles(user.roles, createRoleConfig(env || {}));
}