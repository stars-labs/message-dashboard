// A local Auth0 tenant: the Management API calls the Worker makes
// (server/utils/auth0-management.ts), and a device-login issuer whose signed
// runner tokens the Worker verifies and the Balance Agent accepts. Every login is
// approved at once, as the admin.
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as v from 'valibot';
import { ALL_RUNNER_SCOPES } from '../../shared/api/runner-scopes.ts';
import { parseJson } from '../../shared/parse-json.ts';

const AUDIENCE = 'https://sms-dashboard.local/api';
const NATIVE_CLIENT_ID = 'e2e-native';
const SUBJECT = 'auth0|e2e-admin';
const KEY_ID = 'e2e-key';
const ACCESS_TOKEN_TTL_S = 60 * 60;
const GRANTABLE_SCOPES = new Set<string>(['openid', ...ALL_RUNNER_SCOPES]);

/** The body of an assign (POST) or remove (DELETE) on a user's roles; one role per user here. */
const RoleChange = v.object({ roles: v.array(v.string()) });

interface FakeUser {
  user_id: string;
  email: string;
  name: string;
  last_login: string;
  logins_count: number;
}

const ROLES = [
  { id: 'rol_e2e_admin', name: 'sms-admin' },
  { id: 'rol_e2e_viewer', name: 'sms-viewer' },
];

const USERS: FakeUser[] = [
  {
    user_id: SUBJECT,
    email: 'admin@example.test',
    name: 'E2E Admin',
    last_login: '2026-11-20T08:00:00.000Z',
    logins_count: 12,
  },
  {
    user_id: 'auth0|e2e-viewer',
    email: 'viewer@example.test',
    name: 'E2E Viewer',
    last_login: '2026-11-19T08:00:00.000Z',
    logins_count: 3,
  },
];

export interface FakeAuth0 {
  domain: string;
  /** The API identifier runner tokens are minted for (the Worker's AUTH0_AUDIENCE). */
  audience: string;
  /** The Balance Agent's client id. */
  nativeClientId: string;
  stop(): Promise<void>;
}

function authError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 });
}

export async function startFakeAuth0(): Promise<FakeAuth0> {
  const roleOf = new Map<string, string>([
    [SUBJECT, 'rol_e2e_admin'],
    ['auth0|e2e-viewer', 'rol_e2e_viewer'],
  ]);
  const page = (users: FakeUser[]) => Response.json({ users, total: users.length });

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = {
    keys: [{ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }],
  };
  const scopeOfDevice = new Map<string, string>();
  const scopeOfRefresh = new Map<string, string>();
  let domain = '';

  async function tokens(scope: string): Promise<Response> {
    const accessToken = await new SignJWT({ scope })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
      .setIssuer(`https://${domain}/`)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setIssuedAt()
      .setExpirationTime(`${String(ACCESS_TOKEN_TTL_S)}s`)
      .sign(privateKey);
    const refreshToken = `e2e-refresh-${crypto.randomUUID()}`;
    scopeOfRefresh.set(refreshToken, scope);
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
    });
  }

  function beginDeviceLogin(fields: URLSearchParams): Response {
    if (fields.get('client_id') !== NATIVE_CLIENT_ID) {
      return authError('invalid_request', 'Unknown client');
    }
    if (fields.get('audience') !== AUDIENCE) {
      return authError('invalid_request', `Service not found: ${fields.get('audience') ?? ''}`);
    }
    const requested = (fields.get('scope') ?? '').split(/\s+/);
    const granted = requested.filter((scope) => GRANTABLE_SCOPES.has(scope));
    const deviceCode = `e2e-device-${crypto.randomUUID()}`;
    scopeOfDevice.set(deviceCode, granted.join(' '));
    return Response.json({
      device_code: deviceCode,
      user_code: 'E2E-USER',
      verification_uri: `http://${domain}/activate`,
      verification_uri_complete: `http://${domain}/activate?user_code=E2E-USER`,
      interval: 1,
      expires_in: 300,
    });
  }

  async function token(fields: URLSearchParams): Promise<Response> {
    const grant = fields.get('grant_type');
    if (grant === 'client_credentials') {
      return Response.json({ access_token: 'e2e-management-token', expires_in: 86_400 });
    }
    if (fields.get('client_id') !== NATIVE_CLIENT_ID) {
      return authError('invalid_client', 'Unknown client');
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const scope = scopeOfDevice.get(fields.get('device_code') ?? '');
      if (scope === undefined) return authError('invalid_grant', 'Unknown device code');
      scopeOfDevice.delete(fields.get('device_code') ?? '');
      return tokens(scope);
    }
    if (grant === 'refresh_token') {
      const scope = scopeOfRefresh.get(fields.get('refresh_token') ?? '');
      if (scope === undefined) return authError('invalid_grant', 'Unknown refresh token');
      return tokens(scope);
    }
    return authError('unsupported_grant_type', grant ?? '');
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/.well-known/jwks.json') return Response.json(jwks);
      if (request.method === 'POST' && path === '/oauth/device/code') {
        return beginDeviceLogin(new URLSearchParams(await request.text()));
      }
      if (request.method === 'POST' && path === '/oauth/token') {
        const body = await request.text();
        if (!(request.headers.get('Content-Type') ?? '').includes('json')) {
          return token(new URLSearchParams(body));
        }
        const json = parseJson(body, v.record(v.string(), v.string()));
        return json.ok
          ? token(new URLSearchParams(json.value))
          : authError('invalid_request', json.error);
      }
      if (path === '/api/v2/roles') return Response.json(ROLES);
      if (path === '/api/v2/users') return page(url.searchParams.get('page') === '0' ? USERS : []);

      const members = /^\/api\/v2\/roles\/([^/]+)\/users$/.exec(path);
      if (members) {
        const roleId = decodeURIComponent(members[1] ?? '');
        const inRole = USERS.filter((user) => roleOf.get(user.user_id) === roleId);
        return page(url.searchParams.get('page') === '0' ? inRole : []);
      }

      const userRoles = /^\/api\/v2\/users\/([^/]+)\/roles$/.exec(path);
      if (userRoles) {
        const userId = decodeURIComponent(userRoles[1] ?? '');
        if (request.method === 'GET') {
          return Response.json(ROLES.filter((role) => role.id === roleOf.get(userId)));
        }
        const change = parseJson(await request.text(), RoleChange);
        if (!change.ok) return authError('invalid_request', change.error);
        const [assigned] = change.value.roles;
        if (request.method === 'POST' && assigned !== undefined) roleOf.set(userId, assigned);
        if (request.method === 'DELETE' && change.value.roles.includes(roleOf.get(userId) ?? '')) {
          roleOf.delete(userId);
        }
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    },
  });
  domain = `127.0.0.1:${String(server.port)}`;

  return {
    domain,
    audience: AUDIENCE,
    nativeClientId: NATIVE_CLIENT_ID,
    stop: () => server.stop(true),
  };
}
