import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import type { D1RunResult, D1Statement } from '../lib/d1.js';
import { auth0Handler, ensureDashboardLoginRole, resolveLoginRoles } from './auth0.js';

type CallbackRequest = Parameters<typeof auth0Handler.callback>[0];
type LogoutRequest = Parameters<typeof auth0Handler.logout>[0];

let fetchSpy: Mock<typeof fetch>;
let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, 'fetch');
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  fetchSpy.mockRestore();
  errorSpy.mockRestore();
});

const claim = 'https://sexy.itoken.world/roles';
const env = {
  AUTH0_AUDIENCE: 'https://sexy.itoken.world/api',
  AUTH0_LOGIN_AUDIENCE: 'https://sexy.itoken.world/login-api',
  AUTH0_CLIENT_ID: 'dashboard-client',
  AUTH0_ROLE_NAMESPACE: claim,
};

const runResult: D1RunResult = { meta: { changes: 1, last_row_id: 1 } };

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function mockFetch(respond: (url: string) => Response) {
  fetchSpy.mockImplementation(
    Object.assign(
      (input: string | URL | Request) => Promise.resolve().then(() => respond(requestUrl(input))),
      { preconnect: () => undefined },
    ),
  );
}

function mockSuccessfulAuth(userInfo: Record<string, unknown> = {}) {
  mockFetch((url) => {
    if (url.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'opaque-access-token', id_token: 'id-token' });
    }
    if (url.endsWith('/userinfo')) {
      return Response.json({
        sub: 'auth0|user-1',
        email: 'user@example.com',
        email_verified: true,
        [claim]: ['viewer'],
        ...userInfo,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function callbackRequest({
  dbRun,
  sessionPut,
}: {
  dbRun?: () => Promise<D1RunResult>;
  sessionPut?: () => Promise<void>;
} = {}) {
  const waits: Promise<unknown>[] = [];
  const sessionWrites: string[] = [];
  const statement: D1Statement<'run'> = {
    bind: () => statement,
    run: dbRun ?? (() => Promise.resolve(runResult)),
  };
  const callbackEnv = {
    ...env,
    AUTH0_DOMAIN: 'tenant.example',
    AUTH0_CLIENT_SECRET: 'test-secret',
    DB: { prepare: () => statement },
    SESSIONS: {
      get: () => Promise.resolve(null),
      put: (key: string) => {
        sessionWrites.push(key);
        return sessionPut ? sessionPut() : Promise.resolve();
      },
    },
  };

  const request: CallbackRequest = {
    url: 'https://sexy.itoken.world/callback?code=authorization-code',
    env: callbackEnv,
    ctx: {
      waitUntil(promise) {
        waits.push(promise);
      },
    },
  };
  return { request, waits, sessionWrites };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

function loggedText(): string {
  return errorSpy.mock.calls.flat().map(String).join(' ');
}

describe('Auth0 login role token selection', () => {
  test('uses verified API access-token roles when an audience is configured', async () => {
    const calls: { token: string; audience: string | undefined }[] = [];
    const roles = await resolveLoginRoles({
      userInfo: {},
      tokens: { access_token: 'access', id_token: 'id' },
      env,
      verifyToken: (token, audience) => {
        calls.push({ token, audience });
        return Promise.resolve(token === 'access' ? { [claim]: ['admin'] } : null);
      },
    });

    expect(roles).toEqual(['admin']);
    expect(calls).toEqual([{ token: 'access', audience: env.AUTH0_LOGIN_AUDIENCE }]);
  });

  test('verifies the ID token against the dashboard client ID as a fallback', async () => {
    const calls: { token: string; audience: string | undefined }[] = [];
    const roles = await resolveLoginRoles({
      userInfo: {},
      tokens: { access_token: 'access', id_token: 'id' },
      env,
      verifyToken: (token, audience) => {
        calls.push({ token, audience });
        return Promise.resolve(token === 'id' ? { [claim]: ['viewer'] } : null);
      },
    });

    expect(roles).toEqual(['viewer']);
    expect(calls).toEqual([
      { token: 'access', audience: env.AUTH0_LOGIN_AUDIENCE },
      { token: 'id', audience: env.AUTH0_CLIENT_ID },
    ]);
  });

  test('does not verify tokens when userinfo already has trusted roles', async () => {
    const roles = await resolveLoginRoles({
      userInfo: { [claim]: ['admin'] },
      tokens: {},
      env,
      verifyToken: () => Promise.reject(new Error('must not run')),
    });
    expect(roles).toEqual(['admin']);
  });
});

describe('Auth0 login', () => {
  test('does not use the runner API audience for browser login', () => {
    const response = auth0Handler.login({
      url: 'https://sexy.itoken.world/login',
      env: {
        AUTH0_DOMAIN: 'tenant.example',
        AUTH0_CLIENT_ID: 'dashboard-client',
      },
    });
    const location = new URL(response.headers.get('location') ?? '');
    expect(response.status).toBe(302);
    expect(location.searchParams.get('client_id')).toBe('dashboard-client');
    expect(location.searchParams.get('redirect_uri')).toBe('https://sexy.itoken.world/callback');
    expect(location.searchParams.has('audience')).toBe(false);
  });

  test('requests the configured login audience', () => {
    const response = auth0Handler.login({
      url: 'https://sexy.itoken.world/login',
      env: {
        AUTH0_DOMAIN: 'tenant.example',
        AUTH0_CLIENT_ID: 'dashboard-client',
        AUTH0_LOGIN_AUDIENCE: 'https://sexy.itoken.world/login-api',
      },
    });
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('audience')).toBe('https://sexy.itoken.world/login-api');
  });

  test('answers 500 when Auth0 is not configured', async () => {
    const response = auth0Handler.login({
      url: 'https://sexy.itoken.world/login',
      env: { AUTH0_DOMAIN: 'tenant.example' },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Auth0 configuration missing');
  });
});

describe('Auth0 callback', () => {
  test('completes the callback when userinfo contains a dashboard role', async () => {
    mockSuccessfulAuth();
    const { request, waits, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://sexy.itoken.world/');
    expect(sessionWrites).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  test('delivers the session only as an HttpOnly, Secure, SameSite=Lax cookie', async () => {
    mockSuccessfulAuth();
    const { request, waits, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const match =
      /^auth_token=([^;]+); Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400$/.exec(
        cookies[0] ?? '',
      );
    expect(match).not.toBeNull();
    const token = match?.[1] ?? 'no token';
    expect(sessionWrites).toContain(token);
    expect(response.headers.get('location')).not.toContain(token);
  });

  test('creates the session when the non-critical D1 login audit hits quota', async () => {
    mockSuccessfulAuth();
    const quotaError = new Error(
      "D1_ERROR: Your account has exceeded D1's free tier daily row read limit.",
    );
    const { request, waits, sessionWrites } = callbackRequest({
      dbRun: () => Promise.reject(quotaError),
    });

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://sexy.itoken.world/');
    expect(sessionWrites).toHaveLength(2);
    expect(loggedText()).toContain('auth_audit_failed');
    expect(loggedText()).toContain('D1_QUOTA_EXCEEDED');
  });

  test('denies a disallowed email even when the denial audit hits D1 quota', async () => {
    mockSuccessfulAuth({ email_verified: false });
    const { request, waits, sessionWrites } = callbackRequest({
      dbRun: () => Promise.reject(new Error("exceeded D1's free tier daily row read limit")),
    });

    const response = await auth0Handler.callback(request);
    await Promise.all(waits);

    expect(response.status).toBe(403);
    expect(sessionWrites).toHaveLength(0);
  });

  test('answers 503 without a session when the role lookup in Auth0 is not possible', async () => {
    mockSuccessfulAuth({ [claim]: undefined });
    const { request, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(503);
    expect(sessionWrites).toHaveLength(0);
    expect(loggedText()).toContain('auth_role_reconciliation_failed');
  });

  test('returns a friendly 503 without a session when KV session creation fails', async () => {
    mockSuccessfulAuth();
    const { request } = callbackRequest({
      sessionPut: () => Promise.reject(new Error('sensitive KV provider detail')),
    });

    const response = await auth0Handler.callback(request);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(body).toContain('Authentication is temporarily unavailable');
    expect(body).not.toContain('sensitive KV provider detail');
    expect(loggedText()).toContain('auth_callback_failed');
  });

  test('does not expose the Auth0 token response body', async () => {
    mockFetch(() => new Response('sensitive Auth0 provider detail', { status: 401 }));
    const { request } = callbackRequest();

    const response = await auth0Handler.callback(request);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe('Authentication failed');
    expect(body).not.toContain('sensitive Auth0 provider detail');
  });

  test('answers 401 when userinfo is refused', async () => {
    mockFetch((url) =>
      url.endsWith('/oauth/token')
        ? Response.json({ access_token: 'a' })
        : new Response('no', { status: 401 }),
    );
    const { request, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Authentication failed');
    expect(sessionWrites).toHaveLength(0);
  });

  test('does not reflect an Auth0 callback error description', async () => {
    const { request } = callbackRequest();
    request.url =
      'https://sexy.itoken.world/callback?error=access_denied&error_description=sensitive-provider-detail';

    const response = await auth0Handler.callback(request);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe('Authentication failed');
    expect(body).not.toContain('sensitive-provider-detail');
  });

  test('answers 400 when the authorization code is missing', async () => {
    const { request } = callbackRequest();
    request.url = 'https://sexy.itoken.world/callback';

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Authorization code missing');
  });

  test('answers 503 when AUTH0_DOMAIN is not configured', async () => {
    const { request, sessionWrites } = callbackRequest();
    delete request.env.AUTH0_DOMAIN;

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(503);
    expect(sessionWrites).toHaveLength(0);
  });

  test('answers 503 without a session when the token response has no access_token', async () => {
    mockFetch((url) =>
      url.endsWith('/oauth/token')
        ? Response.json({ id_token: 'id-token' })
        : Response.json({
            sub: 'auth0|user-1',
            email: 'user@example.com',
            email_verified: true,
            [claim]: ['viewer'],
          }),
    );
    const { request, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(503);
    expect(sessionWrites).toHaveLength(0);
  });

  test('answers 503 without a session when the userinfo response has no subject', async () => {
    mockSuccessfulAuth({ sub: undefined });
    const { request, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(503);
    expect(sessionWrites).toHaveLength(0);
  });

  test('answers 503 without a session when the userinfo response is not JSON', async () => {
    mockFetch((url) =>
      url.endsWith('/oauth/token')
        ? Response.json({ access_token: 'a' })
        : new Response('<html>', { status: 200 }),
    );
    const { request, sessionWrites } = callbackRequest();

    const response = await auth0Handler.callback(request);

    expect(response.status).toBe(503);
    expect(sessionWrites).toHaveLength(0);
  });
});

describe('Auth0 logout', () => {
  function logoutRequest(
    stored = new Map<string, string>(),
    domain: string | null = 'tenant.example',
  ) {
    const deleted: string[] = [];
    const request: LogoutRequest = {
      url: 'https://sexy.itoken.world/logout',
      headers: new Headers({ Cookie: 'auth_token=session-1' }),
      env: {
        ...(domain === null ? {} : { AUTH0_DOMAIN: domain }),
        AUTH0_CLIENT_ID: 'dashboard-client',
        SESSIONS: {
          get: (key) => Promise.resolve(stored.get(key) ?? null),
          put: (key, value) => {
            stored.set(key, value);
            return Promise.resolve();
          },
          delete: (key) => {
            deleted.push(key);
            stored.delete(key);
            return Promise.resolve();
          },
        },
      },
    };
    return { request, deleted, stored };
  }

  test('ends the session and redirects to the Auth0 logout endpoint', async () => {
    const { request, deleted } = logoutRequest();

    const response = await auth0Handler.logout(request);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://tenant.example/v2/logout');
    expect(location.searchParams.get('client_id')).toBe('dashboard-client');
    expect(location.searchParams.get('returnTo')).toBe('https://sexy.itoken.world');
    expect(deleted).toEqual(['session-1']);
    expect(response.headers.getSetCookie()).toEqual([
      'auth_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    ]);
  });

  test('ends the session but answers 500 when AUTH0_DOMAIN is not configured', async () => {
    const { request, deleted } = logoutRequest(new Map(), null);

    const response = await auth0Handler.logout(request);

    expect(response.status).toBe(500);
    expect(deleted).toEqual(['session-1']);
  });

  test('removes the token from the per-user session index', async () => {
    const stored = new Map([
      ['session-1', JSON.stringify({ user: { id: 'auth0|u1', roles: ['viewer'] }, expires_at: 1 })],
      ['usess:auth0|u1', JSON.stringify(['session-1', 'session-2'])],
    ]);
    const { request, deleted } = logoutRequest(stored);

    await auth0Handler.logout(request);

    expect(stored.get('usess:auth0|u1')).toBe(JSON.stringify(['session-2']));
    expect(deleted).toEqual(['session-1']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('still ends a session whose stored value is not a session', async () => {
    const { request, deleted } = logoutRequest(new Map([['session-1', 'not json']]));

    const response = await auth0Handler.logout(request);

    expect(response.status).toBe(302);
    expect(deleted).toEqual(['session-1']);
    expect(loggedText()).toContain('Failed to prune session index on logout');
  });

  test('redirects without touching KV when no credential is presented', async () => {
    const { request, deleted } = logoutRequest();
    request.headers = new Headers();

    const response = await auth0Handler.logout(request);

    expect(response.status).toBe(302);
    expect(deleted).toEqual([]);
  });
});

describe('Auth0 current user', () => {
  test('returns the session user with its roles and permissions', async () => {
    const response = auth0Handler.me({
      user: { id: 'auth0|u1', provider: 'auth0', roles: ['viewer'], permissions: ['phones.read'] },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      user: { id: 'auth0|u1', provider: 'auth0', roles: ['viewer'], permissions: ['phones.read'] },
    });
  });

  test('reports no permissions when they have not been attached', async () => {
    const response = auth0Handler.me({ user: { id: 'auth0|u1', roles: ['viewer'] } });

    expect(await response.json()).toEqual({
      success: true,
      user: { id: 'auth0|u1', roles: ['viewer'], permissions: [] },
    });
  });

  test('reports no roles and no permissions without a user', async () => {
    const response = auth0Handler.me({});

    expect(await response.json()).toEqual({
      success: true,
      user: { roles: [], permissions: [] },
    });
  });
});

describe('Auth0 verifyToken', () => {
  test('rejects every token when AUTH0_DOMAIN is not configured', async () => {
    expect(await auth0Handler.verifyToken('any.jwt.token', {})).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('rejects a token that is not a JWT', async () => {
    expect(
      await auth0Handler.verifyToken('garbage', { AUTH0_DOMAIN: 'tenant.example' }),
    ).toBeNull();
  });

  test('rejects every token when no audience is configured, instead of skipping the audience check', async () => {
    mockFetch(() => Response.json({ keys: [] }));
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = [
      segment({ alg: 'RS256', kid: 'k1' }),
      segment({ sub: 'auth0|1', aud: 'another-api', iss: 'https://tenant.example/' }),
      'signature',
    ].join('.');

    expect(await auth0Handler.verifyToken(token, { AUTH0_DOMAIN: 'tenant.example' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Auth0 login role reconciliation', () => {
  const roleEnv = {
    AUTH0_ADMIN_ROLE: 'sms-admin',
    AUTH0_VIEWER_ROLE: 'sms-viewer',
    SESSIONS: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
  };

  test('preserves an existing admin when the login token has no role claim', async () => {
    const assignments: unknown[][] = [];

    const result = await ensureDashboardLoginRole({
      tokenRoles: [],
      userId: 'auth0|admin',
      env: roleEnv,
      getUserRoles: () => Promise.resolve(['balance-runner', 'sms-admin']),
      setUserRole: (...args) => {
        assignments.push(args);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({
      roles: ['balance-runner', 'sms-admin'],
      autoAssignedRole: null,
    });
    expect(assignments).toEqual([]);
  });

  test('auto-assigns viewer only after Auth0 confirms no dashboard role', async () => {
    const assignments: unknown[][] = [];

    const result = await ensureDashboardLoginRole({
      tokenRoles: [],
      userId: 'auth0|new-user',
      env: roleEnv,
      getUserRoles: () => Promise.resolve(['balance-runner']),
      setUserRole: (...args) => {
        assignments.push(args);
        return Promise.resolve();
      },
    });

    expect(result).toEqual({
      roles: ['balance-runner', 'sms-viewer'],
      autoAssignedRole: 'sms-viewer',
    });
    expect(assignments).toEqual([[roleEnv, 'auth0|new-user', 'sms-viewer']]);
  });

  test('keeps the roles the login token already carries', async () => {
    const result = await ensureDashboardLoginRole({
      tokenRoles: ['sms-viewer'],
      userId: 'auth0|viewer',
      env: roleEnv,
      getUserRoles: () => Promise.reject(new Error('must not run')),
      setUserRole: () => Promise.reject(new Error('must not run')),
    });

    expect(result).toEqual({ roles: ['sms-viewer'], autoAssignedRole: null });
  });

  test('fails closed without changing roles when the Management API lookup fails', async () => {
    const assignments: unknown[][] = [];

    const failure = await rejection(
      ensureDashboardLoginRole({
        tokenRoles: [],
        userId: 'auth0|admin',
        env: roleEnv,
        getUserRoles: () => Promise.reject(new Error('management unavailable')),
        setUserRole: (...args) => {
          assignments.push(args);
          return Promise.resolve();
        },
      }),
    );

    expect(failure).toEqual(new Error('management unavailable'));
    expect(assignments).toEqual([]);
  });

  test('completes a bare callback invocation when roles come from a verified token', async () => {
    mockSuccessfulAuth({ sub: 'auth0|user-2', [claim]: undefined });

    const verifyCalls: { token: string; tokenEnv: unknown; audience: string | undefined }[] = [];
    const verifySpy = spyOn(auth0Handler, 'verifyToken').mockImplementation(
      (token, tokenEnv, audience) => {
        verifyCalls.push({ token, tokenEnv, audience });
        return Promise.resolve({ [claim]: ['viewer'] });
      },
    );

    const { request } = callbackRequest();
    request.url = 'https://sexy.qzz.io/callback?code=authorization-code';

    try {
      // This mirrors the router registration, which passes callback without a receiver.
      const callback = auth0Handler.callback;
      const response = await callback(request);

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://sexy.qzz.io/');
      expect(verifyCalls).toEqual([
        {
          token: 'opaque-access-token',
          tokenEnv: request.env,
          audience: env.AUTH0_LOGIN_AUDIENCE,
        },
      ]);
    } finally {
      verifySpy.mockRestore();
    }
  });
});
