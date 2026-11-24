// User + role administration.
//
// `PUT /api/users/:id/role` is the most security-sensitive endpoint in this codebase: it
// is a privilege-escalation primitive. Its guards are therefore explicit and tested:
//
//   * admin-only: its contract (shared/api/contract/users.ts) requires users.write
//   * the target role must be one of the two known roles — no arbitrary role injection
//   * an admin may not change their OWN role, which blocks self-lockout and removes the
//     trivial "promote myself" path if the permission is ever mis-granted
//   * every change writes an audit_logs row with actor, target and old -> new
//   * the target's live sessions are revoked, or a demotion would not take effect for up
//     to 24 hours (roles are snapshotted into the session at login)

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
      // Constant number of Management API calls regardless of user count. The previous
      // version asked Auth0 for each user's roles individually via Promise.all, which
      // returned HTTP 429 (rate limited) as soon as the tenant had more than a few
      // users — the requests all fired concurrently.
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
          // The single role this app cares about, or null if they hold neither.
          role,
        };
      });

      // admin_role/viewer_role are returned explicitly so the UI never has to guess
      // which configured name means what. The names are deployment config
      // (AUTH0_ADMIN_ROLE etc., currently sms-admin/sms-viewer), so a client that
      // hardcoded "admin" would mislabel every row after a rename.
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

    // Allow-list, not a blocklist: only these two strings can ever be assigned.
    const role = knownRoles.find((known) => known === requested);
    if (role === undefined) {
      throw new ORPCError('BAD_REQUEST', {
        message: `role must be one of: ${knownRoles.join(', ')}`,
      });
    }

    // Self-change guard. Blocks an admin demoting themselves into lockout, and means
    // this endpoint can never be used to escalate the caller's own privileges.
    if (targetId === user?.id) {
      throw new ORPCError('FORBIDDEN', {
        message: 'You cannot change your own role. Ask another admin, or use the Auth0 dashboard.',
      });
    }

    try {
      const previousRoles = await getUserRoles(env, targetId);

      await setUserRole(env, targetId, role);

      // Without this the change is invisible until their session expires.
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
