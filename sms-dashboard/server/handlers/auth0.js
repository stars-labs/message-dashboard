import { createRemoteJWKSet, jwtVerify } from 'jose';
import { nanoid } from 'nanoid';
import { createRoleConfig, hasAnyRole, isEmailAllowed, rolesFromToken } from '../../config/auth0-roles.js';
import { extractSessionToken } from '../utils/session-token.js';
import { getUserRoles, setUserRole } from '../utils/auth0-management.js';
import { indexSession, unindexSession } from '../utils/user-sessions.js';

export async function resolveLoginRoles({ userInfo, tokens, env, verifyToken }) {
  const roleConfig = createRoleConfig(env);
  let roles = rolesFromToken(userInfo, roleConfig);

  if (roles.length === 0 && env.AUTH0_LOGIN_AUDIENCE && tokens.access_token) {
    const accessPayload = await verifyToken(tokens.access_token, env.AUTH0_LOGIN_AUDIENCE);
    roles = rolesFromToken(accessPayload, roleConfig);
  }

  if (roles.length === 0 && tokens.id_token) {
    const idPayload = await verifyToken(tokens.id_token, env.AUTH0_CLIENT_ID);
    roles = rolesFromToken(idPayload, roleConfig);
  }

  return roles;
}

/**
 * Reconcile a login token with Auth0 before provisioning the default viewer role.
 *
 * A missing custom claim does not prove that the user has no roles. Treating it as
 * proof previously let an Action/namespace failure demote an existing administrator:
 * setUserRole(viewer) removes the configured admin role. Auth0's Management API is the
 * source of truth whenever the signed login token carries no recognised Dashboard role.
 */
export async function ensureDashboardLoginRole({
  tokenRoles,
  userId,
  env,
  getUserRoles: loadUserRoles = getUserRoles,
  setUserRole: assignUserRole = setUserRole,
}) {
  const roleConfig = createRoleConfig(env);
  const rolesFromLogin = Array.isArray(tokenRoles) ? tokenRoles : [];

  if (hasAnyRole(rolesFromLogin, roleConfig)) {
    return { roles: rolesFromLogin, autoAssignedRole: null };
  }

  const assignedRoles = await loadUserRoles(env, userId);
  if (hasAnyRole(assignedRoles, roleConfig)) {
    return { roles: assignedRoles, autoAssignedRole: null };
  }

  await assignUserRole(env, userId, roleConfig.VIEWER_ROLE);
  return {
    roles: [...new Set([...assignedRoles, roleConfig.VIEWER_ROLE])],
    autoAssignedRole: roleConfig.VIEWER_ROLE,
  };
}

export const auth0Handler = {
  // Login - redirect to Auth0
  async login(request) {
    console.log('[Auth0 Handler] Login route hit');
    const { env } = request;
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/callback`;
    
    if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID) {
      // Auth0 not configured - return error
      return new Response('Auth0 configuration missing. Please configure AUTH0_DOMAIN and AUTH0_CLIENT_ID.', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    const authUrl = new URL(`https://${env.AUTH0_DOMAIN}/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', nanoid());
    
    // Browser login creates a Dashboard session from the verified ID token. The
    // runner API audience belongs to the Native Balance Agent and must not be
    // requested by this Regular Web Application unless a separate login audience
    // is explicitly configured.
    if (env.AUTH0_LOGIN_AUDIENCE) {
      authUrl.searchParams.set('audience', env.AUTH0_LOGIN_AUDIENCE);
    }
    
    return Response.redirect(authUrl.toString(), 302);
  },

  // Callback - handle Auth0 response
  async callback(request) {
    const { env } = request;
    const roleConfig = createRoleConfig(env);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    
    
    if (error) {
      return new Response(`Authentication error: ${errorDescription || error}`, { status: 401 });
    }
    
    if (!code) {
      return new Response('Authorization code missing', { status: 400 });
    }
    
    try {
      // Exchange code for tokens
      const redirectUri = `${url.origin}/callback`;
      // Token exchange with Auth0
      
      const tokenResponse = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: env.AUTH0_CLIENT_ID,
          client_secret: env.AUTH0_CLIENT_SECRET,
          code: code,
          redirect_uri: redirectUri
        })
      });
      
      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        console.error('Token exchange failed:', tokenResponse.status, error);
        // Token exchange failed
        return new Response(`Authentication failed: ${error}`, { status: 401 });
      }
      
      const tokens = await tokenResponse.json();
      
      // Get user info from Auth0
      const userResponse = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`
        }
      });
      
      if (!userResponse.ok) {
        const errorText = await userResponse.text();
        console.error('Failed to get user info:', userResponse.status, errorText);
        return new Response(`Failed to get user info: ${errorText || userResponse.statusText}`, { status: 401 });
      }
      
      const userInfo = await userResponse.json();
      
      // Create or update user in database
      const userId = userInfo.sub;
      
      // Roles come from the namespaced claim only, via the shared config so this
      // path cannot drift from the JWT middleware. The previous version preferred a
      // top-level `roles` claim and, failing that, base64-decoded the access token
      // WITHOUT verifying its signature and trusted the roles it found there. Those
      // roles are persisted into the KV session below, so they are a real
      // authorization input. See docs/SECURITY-REVIEW.md finding 5.
      const userRoles = await resolveLoginRoles({
        userInfo,
        tokens,
        env,
        verifyToken: (token, audience) => this.verifyToken(token, env, audience),
      });

      const user = {
        id: userId,
        email: userInfo.email,
        name: userInfo.name || userInfo.nickname,
        picture: userInfo.picture,
        provider: 'auth0',
        roles: userRoles
      };
      
      // No need to store user in database - Auth0 handles user management
      // Just log the authentication event in audit_logs
      await env.DB.prepare(`
        INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
        VALUES ('login', 'user', ?, ?, ?, datetime('now'))
      `).bind(
        user.id,
        user.email,
        JSON.stringify({ provider: 'auth0', roles: userRoles })
      ).run();
      
      // Email policy: verified address, on an allowed domain. Runs unconditionally —
      // the old version only ran when ALLOWED_EMAIL_DOMAINS was set, so an unset list
      // meant no email check at all, and it read the domain from the first '@' with a
      // case-sensitive compare. See config/auth0-roles.js.
      const emailCheck = isEmailAllowed(userInfo, env);

      if (!emailCheck.allowed) {
        await env.DB.prepare(`
          INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
          VALUES ('login_denied', 'user', ?, ?, ?, datetime('now'))
        `).bind(
          user.id,
          user.email || null,
          JSON.stringify({ reason: emailCheck.reason, domain: emailCheck.domain })
        ).run();

        return new Response(`Access denied: ${emailCheck.reason}`, { status: 403 });
      }

      // First-time users are provisioned as `viewer`, but only after Auth0 confirms
      // that no known Dashboard role is already assigned. A missing token claim can
      // mean the Post-Login Action or namespace is broken; it must never demote an
      // existing administrator.
      //
      // Deliberately AFTER the verified-email and allowed-domain checks above, so this
      // can only ever fire for someone already entitled to access, and deliberately
      // hard-coded to the viewer role — this code path must never be able to grant
      // admin. The app still requires an *explicit* role afterwards, so the gate below
      // stays fail-closed; "default viewer" is a real Auth0 role assignment, not the
      // absence of one. See docs/SECURITY-REVIEW.md finding 1.
      try {
        const roleResolution = await ensureDashboardLoginRole({
          tokenRoles: user.roles,
          userId: user.id,
          env,
        });
        user.roles = roleResolution.roles;

        if (roleResolution.autoAssignedRole) {
          await env.DB.prepare(`
            INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
            VALUES ('role_autoassigned', 'user', ?, ?, ?, datetime('now'))
          `).bind(
            user.id,
            user.email || null,
            JSON.stringify({ role: roleResolution.autoAssignedRole, domain: emailCheck.domain })
          ).run();
        }
      } catch (provisionError) {
        // Deny rather than infer anything from a missing claim. This covers both the
        // authoritative role lookup and a genuine first-user viewer assignment.
        console.error('Login role reconciliation failed:', provisionError);
        return Response.redirect(
          new URL('/login?error=provisioning_failed', url.origin).toString(),
          302
        );
      }

      // Role gate. Uses the shared helper rather than a third copy of this logic, and
      // there is no env flag that can skip it — the old
      // `&& env.USE_AUTH0_ROLES !== 'false'` let a roleless user through, and
      // production shipped with that flag set to "false".
      //
      // Checked BEFORE the session is minted: the old order wrote a valid 24-hour
      // session into KV and only then redirected the roleless user away, leaving a
      // usable credential behind for an account that was just denied.
      if (!hasAnyRole(user.roles, roleConfig)) {
        return Response.redirect(new URL('/login?error=no_role', url.origin).toString(), 302);
      }

      // Create session
      const sessionToken = nanoid();
      const sessionData = {
        user: user,
        id_token: tokens.id_token,
        expires_at: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
      };

      await env.SESSIONS.put(sessionToken, JSON.stringify(sessionData), {
        expirationTtl: 24 * 60 * 60 // 24 hours in seconds
      });

      // Reverse index so a role change can find and kill this session. Without it a
      // demotion would not take effect until the 24h TTL expired, because roles are
      // snapshotted into sessionData above.
      await indexSession(env, user.id, sessionToken);

      // The session token is delivered ONLY as an HttpOnly cookie. It used to also be
      // appended to this redirect as `?token=...`, which leaked a live 24-hour
      // credential into the Referer header on any outbound link, into browser history,
      // and into Workers request logs — defeating the HttpOnly flag set here.
      // See docs/SECURITY-REVIEW.md finding 4.
      const frontendUrl = new URL('/', url.origin);

      return new Response(null, {
        status: 302,
        headers: {
          'Location': frontendUrl.toString(),
          'Set-Cookie': `auth_token=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
        }
      });
    } catch (error) {
      // Auth callback error
      return new Response(`Authentication failed: ${error.message}`, { status: 500 });
    }
  },

  // Logout
  async logout(request) {
    const { env } = request;

    // Reads the cookie as well as the header, otherwise a browser logout left the KV
    // session alive until it expired 24 hours later.
    const credential = extractSessionToken(
      request.headers.get('Authorization'),
      request.headers.get('Cookie')
    );

    if (credential) {
      // Read the session first so the reverse index can be pruned; otherwise it would
      // accumulate dead tokens until its own TTL expired.
      try {
        const raw = await env.SESSIONS.get(credential.token);
        const userId = raw ? JSON.parse(raw)?.user?.id : null;
        if (userId) await unindexSession(env, userId, credential.token);
      } catch (error) {
        console.error('Failed to prune session index on logout:', error);
      }

      await env.SESSIONS.delete(credential.token);
    }

    const url = new URL(request.url);
    const logoutUrl = new URL(`https://${env.AUTH0_DOMAIN}/v2/logout`);
    logoutUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID);
    logoutUrl.searchParams.set('returnTo', url.origin);

    // Clear the cookie locally too; the Auth0 redirect only ends the IdP session.
    return new Response(null, {
      status: 302,
      headers: {
        'Location': logoutUrl.toString(),
        'Set-Cookie': 'auth_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
      }
    });
  },

  // Get current user
  async me(request) {
    const { user } = request;

    return new Response(JSON.stringify({
      success: true,
      user: {
        ...user,
        // Explicit rather than relying on enrichUserPermissions having run: if this
        // route is ever wired without it, the client sees "no permissions" and hides
        // everything, instead of `undefined` which `.includes()` would throw on.
        roles: Array.isArray(user?.roles) ? user.roles : [],
        permissions: Array.isArray(user?.permissions) ? user.permissions : []
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  },

  // Verify JWT token (for API calls)
  async verifyToken(token, env, audience = env.AUTH0_AUDIENCE || env.AUTH0_CLIENT_ID) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`));
      
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: `https://${env.AUTH0_DOMAIN}/`,
        audience
      });
      
      return payload;
    } catch (error) {
      // JWT verification failed
      return null;
    }
  }
};
