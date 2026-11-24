// The Management API calls the Worker makes (server/utils/auth0-management.ts),
// answered from memory so no test reaches a real tenant.

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
    user_id: 'auth0|e2e-admin',
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

interface FakeAuth0 {
  domain: string;
  stop(): Promise<void>;
}

export function startFakeAuth0(): FakeAuth0 {
  const roleOf = new Map<string, string>([
    ['auth0|e2e-admin', 'rol_e2e_admin'],
    ['auth0|e2e-viewer', 'rol_e2e_viewer'],
  ]);
  const page = (users: FakeUser[]) => Response.json({ users, total: users.length });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === 'POST' && path === '/oauth/token') {
        return Response.json({ access_token: 'e2e-management-token', expires_in: 86_400 });
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
        if (request.method === 'DELETE') roleOf.delete(userId);
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    domain: `127.0.0.1:${String(server.port)}`,
    stop: () => server.stop(true),
  };
}
