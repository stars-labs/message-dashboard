import { ORPCError } from '@orpc/server';
import { createRoleConfig, getKnownRoles } from '../../config/auth0-roles.js';
import type { SetRoleResponse, UsersResponse } from '../../shared/api/users.js';
import type { D1 } from '../lib/d1.js';
import type { KV } from '../lib/kv.js';
import {
  Auth0ManagementError,
  getUserRoles,
  listUsersWithRoles,
  setUserRole,
  type Auth0ManagementEnv,
} from '../utils/auth0-management.js';
import { revokeUserSessions } from '../utils/user-sessions.js';
import { writeAuditLog } from '../utils/audit-log.js';

interface ListCall {
  env: Auth0ManagementEnv;
  /** Headers to add to the answer, error or not. */
  resHeaders: Headers;
}

interface SetRoleCall extends ListCall {
  env: Auth0ManagementEnv & { SESSIONS: KV<'get' | 'put' | 'delete'>; DB: D1<'run'> };
  user?: { id: string; email?: string | undefined } | undefined;
}

/**
 * The error to answer for a failed Management API call, without leaking its body.
 * Auth0 rate limiting is a 503 the caller can retry, carrying Auth0's Retry-After.
 */
function managementFailure(error: unknown, resHeaders: Headers): ORPCError<string, undefined> {
  const message = error instanceof Error ? error.message : 'unknown error';
  const body = error instanceof Auth0ManagementError ? error.body : undefined;
  console.error('Auth0 Management API error:', message, body);
  if (error instanceof Auth0ManagementError && error.status === 429) {
    if (error.retryAfter !== null) resHeaders.set('Retry-After', error.retryAfter);
    return new ORPCError('SERVICE_UNAVAILABLE', {
      status: 503,
      message: 'Auth0 is rate limiting the Management API; try again shortly',
    });
  }
  return new ORPCError('BAD_GATEWAY', {
    status: 502,
    message: `Auth0 Management API request failed: ${message}`,
  });
}

export const usersHandler = {
  /** GET /api/users — every tenant user with their current role. */
  async list({ env, resHeaders }: ListCall): Promise<UsersResponse> {
    const roleConfig = createRoleConfig(env);

    try {
      // Per-user role calls hit Auth0's 429 rate limit; this makes a constant number of calls.
      const { users, roleByUserId } = await listUsersWithRoles(env);

      const withRoles = users.map((u) => {
        const role = roleByUserId.get(u.user_id) ?? null;
        return {
          id: u.user_id,
          email: u.email ?? null,
          name: u.name ?? null,
          last_login: u.last_login ?? null,
          logins_count: u.logins_count ?? 0,
          roles: role ? [role] : [],
          role,
        };
      });

      // Role names are deployment config (AUTH0_ADMIN_ROLE etc.), so the UI must be told them.
      return {
        success: true,
        users: withRoles,
        known_roles: getKnownRoles(roleConfig),
        admin_role: roleConfig.ADMIN_ROLE,
        viewer_role: roleConfig.VIEWER_ROLE,
      };
    } catch (error) {
      throw managementFailure(error, resHeaders);
    }
  },

  /** PUT /api/users/:id/role — body { role: 'admin' | 'viewer' }. */
  async setRole(
    { env, user, resHeaders }: SetRoleCall,
    targetId: string,
    requested: string,
  ): Promise<SetRoleResponse> {
    const knownRoles = getKnownRoles(createRoleConfig(env));

    const role = knownRoles.find((known) => known === requested);
    if (role === undefined) {
      throw new ORPCError('BAD_REQUEST', {
        message: `role must be one of: ${knownRoles.join(', ')}`,
      });
    }

    // Prevents self-lockout and self-escalation.
    if (targetId === user?.id) {
      throw new ORPCError('FORBIDDEN', {
        message: 'You cannot change your own role. Ask another admin, or use the Auth0 dashboard.',
      });
    }

    try {
      const previousRoles = await getUserRoles(env, targetId);

      await setUserRole(env, targetId, role);

      // Roles are snapshotted into the session at login; without this a demotion waits out the 24h TTL.
      const revoked = await revokeUserSessions(env, targetId);

      await writeAuditLog(env, {
        action: 'role_changed',
        resourceId: targetId,
        userEmail: user?.email ?? null,
        details: {
          actor_id: user?.id ?? null,
          target_id: targetId,
          from: previousRoles,
          to: role,
          sessions_revoked: revoked,
        },
      });

      return {
        success: true,
        user_id: targetId,
        role,
        previous_roles: previousRoles,
        sessions_revoked: revoked,
      };
    } catch (error) {
      throw managementFailure(error, resHeaders);
    }
  },
};
