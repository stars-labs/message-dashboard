import { createRemoteJWKSet, jwtVerify } from 'jose';
import { nanoid } from 'nanoid';
import * as v from 'valibot';
import { parseJson, readJson } from '../../shared/parse-json.js';
import {
  createRoleConfig,
  hasAnyRole,
  isEmailAllowed,
  rolesFromToken,
  type RoleEnv,
} from '../../config/auth0-roles.js';
import type { D1 } from '../lib/d1.js';
import { readKvJson, type KV } from '../lib/kv.js';
import { extractSessionToken } from '../utils/session-token.js';
import { getUserRoles, setUserRole, type Auth0ManagementEnv } from '../utils/auth0-management.js';
import { indexSession, unindexSession } from '../utils/user-sessions.js';
import { scheduleAuthAudit } from '../utils/audit-log.js';
import { boundedErrorText } from '../utils/d1-error.js';

/** The authorization_code token response (RFC 6749 §5.1; id_token per OpenID Connect Core §3.1.3.3). */
const TokenSet = v.object({
  access_token: v.string(),
  id_token: v.optional(v.string()),
});

interface LoginTokens {
  access_token?: string | undefined;
  id_token?: string | undefined;
}

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

/** The KV session written by the login callback under the auth_token value. */
export const StoredSession = v.object({
  user: SessionUser,
  id_token: v.optional(v.string()),
  expires_at: v.number(),
});

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

const COOKIE_CLEARED = 'auth_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

interface CallbackEnv extends Auth0ManagementEnv {
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  AUTH0_AUDIENCE?: string;
  AUTH0_LOGIN_AUDIENCE?: string;
  ALLOWED_EMAIL_DOMAINS?: string;
  DB: D1<'run'>;
}

interface LoginRolesEnv extends RoleEnv {
  AUTH0_CLIENT_ID?: string;
  AUTH0_LOGIN_AUDIENCE?: string;
}

interface LoginRequest {
  url: string;
  env: { AUTH0_DOMAIN?: string; AUTH0_CLIENT_ID?: string; AUTH0_LOGIN_AUDIENCE?: string };
}

interface CallbackRequest {
  url: string;
  env: CallbackEnv;
  ctx: { waitUntil(promise: Promise<unknown>): void };
}

interface LogoutRequest {
  url: string;
  headers: { get(name: string): string | null };
  env: {
    AUTH0_DOMAIN?: string;
    AUTH0_CLIENT_ID?: string;
    SESSIONS: KV<'get' | 'put' | 'delete'>;
  };
}

interface MeRequest {
  user?: SessionUser & { permissions?: string[] };
}

interface VerifyEnv {
  AUTH0_DOMAIN?: string;
  AUTH0_AUDIENCE?: string;
  AUTH0_CLIENT_ID?: string;
}

/** What Auth0's /userinfo returns for the openid profile email scopes (OpenID Connect Core §5.1). */
const UserInfo = v.object({
  sub: v.string(),
  email: v.optional(v.string()),
  email_verified: v.optional(v.boolean()),
  name: v.optional(v.string()),
  nickname: v.optional(v.string()),
  picture: v.optional(v.string()),
});

/** The same body read as a bag of claims, because the roles claim has a configured name. */
const Claims = v.record(v.string(), v.unknown());

/** Signature of auth0Handler.verifyToken, injectable for tests. */
type VerifyToken = (token: string, audience?: string) => Promise<Record<string, unknown> | null>;

function logAuthFailure(
  event: string,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      ...details,
      error: boundedErrorText(error),
    }),
  );
}

function authenticationUnavailable(): Response {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authentication unavailable</title>
  </head>
  <body>
    <main>
      <h1>Authentication is temporarily unavailable</h1>
      <p>Please try again shortly.</p>
      <p><a href="/login">Try again</a></p>
    </main>
  </body>
</html>`;

  return new Response(body, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function resolveLoginRoles({
  userInfo,
  tokens,
  env,
  verifyToken,
}: {
  userInfo: Record<string, unknown>;
  tokens: LoginTokens;
  env: LoginRolesEnv;
  verifyToken: VerifyToken;
}): Promise<string[]> {
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
}: {
  tokenRoles: string[];
  userId: string;
  env: Auth0ManagementEnv;
  getUserRoles?: (env: Auth0ManagementEnv, userId: string) => Promise<string[]>;
  setUserRole?: (env: Auth0ManagementEnv, userId: string, roleName: string) => Promise<void>;
}): Promise<{ roles: string[]; autoAssignedRole: string | null }> {
  const roleConfig = createRoleConfig(env);

  if (hasAnyRole(tokenRoles, roleConfig)) {
    return { roles: tokenRoles, autoAssignedRole: null };
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
  login(request: LoginRequest): Response {
    console.log('[Auth0 Handler] Login route hit');
    const { env } = request;
    const url = new URL(request.url);
    const redirectUri = `${url.origin}/callback`;

    if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID) {
      // Auth0 not configured - return error
      return new Response(
        'Auth0 configuration missing. Please configure AUTH0_DOMAIN and AUTH0_CLIENT_ID.',
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        },
      );
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
  callback: async (request: CallbackRequest): Promise<Response> => {
    const { env } = request;
    const roleConfig = createRoleConfig(env);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      console.error(
        JSON.stringify({
          event: 'auth_provider_callback_failed',
          provider_error: error.slice(0, 100),
        }),
      );
      return new Response('Authentication failed', {
        status: 401,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    if (!code) {
      return new Response('Authorization code missing', { status: 400 });
    }

    try {
      const domain = env.AUTH0_DOMAIN;
      if (!domain) throw new Error('AUTH0_DOMAIN is not configured');

      // Exchange code for tokens
      const redirectUri = `${url.origin}/callback`;
      // Token exchange with Auth0

      const tokenResponse = await fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: env.AUTH0_CLIENT_ID,
          client_secret: env.AUTH0_CLIENT_SECRET,
          code: code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        console.error(
          JSON.stringify({
            event: 'auth_token_exchange_failed',
            status: tokenResponse.status,
          }),
        );
        return new Response('Authentication failed', {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      const tokenBody = await readJson(tokenResponse, TokenSet);
      if (!tokenBody.ok) {
        throw new Error(`Auth0 token response is malformed: ${tokenBody.error}`);
      }
      const tokens = tokenBody.value;

      // Get user info from Auth0
      const userResponse = await fetch(`https://${domain}/userinfo`, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (!userResponse.ok) {
        console.error(
          JSON.stringify({
            event: 'auth_userinfo_failed',
            status: userResponse.status,
          }),
        );
        return new Response('Authentication failed', {
          status: 401,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      const userBody = await userResponse.text();
      const infoParsed = parseJson(userBody, UserInfo);
      if (!infoParsed.ok) {
        throw new Error(`Auth0 userinfo response is malformed: ${infoParsed.error}`);
      }
      const claimsParsed = parseJson(userBody, Claims);
      if (!claimsParsed.ok) {
        throw new Error(`Auth0 userinfo response is malformed: ${claimsParsed.error}`);
      }
      const claims = claimsParsed.value;
      const userInfo = infoParsed.value;

      // Create or update user in database
      const userId = userInfo.sub;

      // Roles come from the namespaced claim only, via the shared config so this
      // path cannot drift from the JWT middleware. The previous version preferred a
      // top-level `roles` claim and, failing that, base64-decoded the access token
      // WITHOUT verifying its signature and trusted the roles it found there. Those
      // roles are persisted into the KV session below, so they are a real
      // authorization input. See docs/SECURITY-REVIEW.md finding 5.
      const userRoles = await resolveLoginRoles({
        userInfo: claims,
        tokens,
        env,
        // `callback` is passed as a bare handler from the router (`router.get('/callback',
        // auth0Handler.callback)`), so relying on `this` here makes it undefined in
        // production and crashes with "Cannot read properties of undefined
        // (reading 'verifyToken')". Call the exported handler explicitly instead of
        // depending on invocation context.
        verifyToken: (token: string, audience?: string) =>
          auth0Handler.verifyToken(token, env, audience),
      });

      const user: SessionUser = {
        id: userId,
        email: userInfo.email,
        name: nonEmpty(userInfo.name) ?? userInfo.nickname,
        picture: userInfo.picture,
        provider: 'auth0',
        roles: userRoles,
      };

      // Email policy: verified address, on an allowed domain. Runs unconditionally —
      // the old version only ran when ALLOWED_EMAIL_DOMAINS was set, so an unset list
      // meant no email check at all, and it read the domain from the first '@' with a
      // case-sensitive compare. See config/auth0-roles.js.
      const emailCheck = isEmailAllowed(userInfo, env);

      if (!emailCheck.allowed) {
        scheduleAuthAudit(request, {
          action: 'login_denied',
          resourceId: user.id,
          userEmail: nonEmpty(user.email) ?? null,
          details: { reason: emailCheck.reason, domain: emailCheck.domain },
        });

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
          scheduleAuthAudit(request, {
            action: 'role_autoassigned',
            resourceId: user.id,
            userEmail: nonEmpty(user.email) ?? null,
            details: { role: roleResolution.autoAssignedRole, domain: emailCheck.domain },
          });
        }
      } catch (provisionError) {
        // Deny rather than infer anything from a missing claim. This covers both the
        // authoritative role lookup and a genuine first-user viewer assignment.
        logAuthFailure('auth_role_reconciliation_failed', provisionError);
        return authenticationUnavailable();
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
        expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      };

      await env.SESSIONS.put(sessionToken, JSON.stringify(sessionData), {
        expirationTtl: 24 * 60 * 60, // 24 hours in seconds
      });

      // Reverse index so a role change can find and kill this session. Without it a
      // demotion would not take effect until the 24h TTL expired, because roles are
      // snapshotted into sessionData above.
      await indexSession(env, user.id, sessionToken);

      scheduleAuthAudit(request, {
        action: 'login',
        resourceId: user.id,
        userEmail: nonEmpty(user.email) ?? null,
        details: { provider: 'auth0', roles: user.roles },
      });

      // The session token is delivered ONLY as an HttpOnly cookie. It used to also be
      // appended to this redirect as `?token=...`, which leaked a live 24-hour
      // credential into the Referer header on any outbound link, into browser history,
      // and into Workers request logs — defeating the HttpOnly flag set here.
      // See docs/SECURITY-REVIEW.md finding 4.
      const frontendUrl = new URL('/', url.origin);

      return new Response(null, {
        status: 302,
        headers: {
          Location: frontendUrl.toString(),
          'Set-Cookie': `auth_token=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
        },
      });
    } catch (exchangeError) {
      logAuthFailure('auth_callback_failed', exchangeError);
      return authenticationUnavailable();
    }
  },

  // Logout
  logout: async (request: LogoutRequest): Promise<Response> => {
    const { env } = request;

    // Reads the cookie as well as the header, otherwise a browser logout left the KV
    // session alive until it expired 24 hours later.
    const credential = extractSessionToken(
      request.headers.get('Authorization'),
      request.headers.get('Cookie'),
    );

    if (credential) {
      // Read the session first so the reverse index can be pruned; otherwise it would
      // accumulate dead tokens until its own TTL expired.
      try {
        const stored = await readKvJson(env.SESSIONS, credential.token, StoredSession);
        if (stored?.ok === true) {
          await unindexSession(env, stored.value.user.id, credential.token);
        } else if (stored !== null) {
          console.error('Failed to prune session index on logout:', stored.error);
        }
      } catch (error) {
        console.error('Failed to prune session index on logout:', error);
      }

      await env.SESSIONS.delete(credential.token);
    }

    const url = new URL(request.url);
    if (!env.AUTH0_DOMAIN) {
      return new Response('Auth0 configuration missing. Please configure AUTH0_DOMAIN.', {
        status: 500,
        headers: { 'Content-Type': 'text/plain', 'Set-Cookie': COOKIE_CLEARED },
      });
    }
    const logoutUrl = new URL(`https://${env.AUTH0_DOMAIN}/v2/logout`);
    logoutUrl.searchParams.set('client_id', env.AUTH0_CLIENT_ID ?? '');
    logoutUrl.searchParams.set('returnTo', url.origin);

    // Clear the cookie locally too; the Auth0 redirect only ends the IdP session.
    return new Response(null, {
      status: 302,
      headers: {
        Location: logoutUrl.toString(),
        'Set-Cookie': COOKIE_CLEARED,
      },
    });
  },

  // Get current user
  me(request: MeRequest): Response {
    const { user } = request;

    return new Response(
      JSON.stringify({
        success: true,
        user: {
          ...user,
          // Explicit rather than relying on enrichUserPermissions having run: if this
          // route is ever wired without it, the client sees "no permissions" and hides
          // everything, instead of `undefined` which `.includes()` would throw on.
          roles: user?.roles ?? [],
          permissions: user?.permissions ?? [],
        },
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },

  // Verify JWT token (for API calls)
  async verifyToken(
    token: string,
    env: VerifyEnv,
    audience: string | undefined = nonEmpty(env.AUTH0_AUDIENCE) ?? env.AUTH0_CLIENT_ID,
  ): Promise<Record<string, unknown> | null> {
    if (!env.AUTH0_DOMAIN) return null;

    try {
      const JWKS = createRemoteJWKSet(new URL(`https://${env.AUTH0_DOMAIN}/.well-known/jwks.json`));

      // Calling with no audience would make jose reject on `aud`; fall back to the
      // client id so the call is always well-defined.
      const expectedAudience = audience ?? env.AUTH0_CLIENT_ID;
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: `https://${env.AUTH0_DOMAIN}/`,
        ...(expectedAudience === undefined ? {} : { audience: expectedAudience }),
      });

      return payload;
    } catch {
      // JWT verification failed
      return null;
    }
  },
};
