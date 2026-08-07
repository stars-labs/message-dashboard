// User + role administration.
//
// `PUT /api/users/:id/role` is the most security-sensitive endpoint in this codebase: it
// is a privilege-escalation primitive. Its guards are therefore explicit and tested:
//
//   * admin-only, enforced by requirePermission('users.write') at the route
//   * the target role must be one of the two known roles — no arbitrary role injection
//   * an admin may not change their OWN role, which blocks self-lockout and removes the
//     trivial "promote myself" path if the permission is ever mis-granted
//   * every change writes an audit_logs row with actor, target and old -> new
//   * the target's live sessions are revoked, or a demotion would not take effect for up
//     to 24 hours (roles are snapshotted into the session at login)

import { createRoleConfig, getKnownRoles } from '../../config/auth0-roles.js';
import { getUserRoles, listUsersWithRoles, setUserRole } from '../utils/auth0-management.js';
import { revokeUserSessions } from '../utils/user-sessions.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Map an Auth0ManagementError to a response without leaking its body to the client. */
function managementFailure(error) {
  console.error('Auth0 Management API error:', error?.message, error?.body);
  return json(
    {
      success: false,
      error: 'Auth0 Management API request failed',
      detail: error?.message ?? 'unknown error',
    },
    502
  );
}

export const usersHandler = {
  /** GET /api/users — every tenant user with their current role. */
  async list(request) {
    const { env } = request;
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
      return json({
        success: true,
        users: withRoles,
        known_roles: getKnownRoles(roleConfig),
        admin_role: roleConfig.ADMIN_ROLE,
        viewer_role: roleConfig.VIEWER_ROLE,
      });
    } catch (error) {
      return managementFailure(error);
    }
  },

  /** PUT /api/users/:id/role — body { role: 'admin' | 'viewer' }. */
  async setRole(request) {
    const { env, user } = request;
    const targetId = request.params?.id;
    const roleConfig = createRoleConfig(env);
    const knownRoles = getKnownRoles(roleConfig);

    if (!targetId) {
      return json({ success: false, error: 'Missing user id' }, 400);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Body must be JSON' }, 400);
    }

    const role = body?.role;

    // Allow-list, not a blocklist: only these two strings can ever be assigned.
    if (typeof role !== 'string' || !knownRoles.includes(role)) {
      return json(
        { success: false, error: `role must be one of: ${knownRoles.join(', ')}` },
        400
      );
    }

    // Self-change guard. Blocks an admin demoting themselves into lockout, and means
    // this endpoint can never be used to escalate the caller's own privileges.
    if (targetId === user?.id) {
      return json(
        {
          success: false,
          error: 'You cannot change your own role. Ask another admin, or use the Auth0 dashboard.',
        },
        403
      );
    }

    try {
      const previousRoles = await getUserRoles(env, targetId);

      await setUserRole(env, targetId, role);

      // Without this the change is invisible until their session expires.
      const revoked = await revokeUserSessions(env, targetId);

      await env.DB.prepare(`
        INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
        VALUES ('role_changed', 'user', ?, ?, ?, datetime('now'))
      `).bind(
        targetId,
        user?.email ?? null,
        JSON.stringify({
          actor_id: user?.id ?? null,
          target_id: targetId,
          from: previousRoles,
          to: role,
          sessions_revoked: revoked,
        })
      ).run();

      return json({
        success: true,
        user_id: targetId,
        role,
        previous_roles: previousRoles,
        sessions_revoked: revoked,
      });
    } catch (error) {
      return managementFailure(error);
    }
  },
};
