import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ManagedUser, SetRoleResponse, UsersResponse } from '../../shared/api/users.js';
import { auth } from './auth.js';
import UserManagement from './UserManagement.svelte';

const originalBaseUrl = auth.baseUrl;
const originalConfirm = globalThis.confirm;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
  globalThis.confirm = originalConfirm;
});

function stubFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response): void {
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(input, init)),
      { preconnect: () => undefined },
    ),
  );
}

function user(overrides: Partial<ManagedUser> = {}): ManagedUser {
  return {
    id: 'auth0|1',
    email: 'a@example.com',
    name: 'Alice',
    last_login: null,
    logins_count: 0,
    roles: ['ops-viewer'],
    role: 'ops-viewer',
    ...overrides,
  };
}

function usersResponse(users: ManagedUser[]): UsersResponse {
  return {
    success: true,
    users,
    known_roles: ['ops-admin', 'ops-viewer'],
    admin_role: 'ops-admin',
    viewer_role: 'ops-viewer',
  };
}

function roleResponse(overrides: Partial<SetRoleResponse> = {}): SetRoleResponse {
  return {
    success: true,
    user_id: 'auth0|1',
    role: 'ops-admin',
    previous_roles: ['ops-viewer'],
    sessions_revoked: 3,
    ...overrides,
  };
}

function emailsInOrder(container: HTMLElement): string[] {
  const table = container.querySelector('table');
  if (!table) throw new Error('no table rendered');
  return Array.from(table.querySelectorAll('tbody tr')).map(
    (row) => row.querySelector('.font-mono')?.textContent.trim() ?? '',
  );
}

describe('UserManagement', () => {
  test('lists roleless users first, then by email', async () => {
    stubFetch(() =>
      Response.json(
        usersResponse([
          user({ id: 'u-c', email: 'c@example.com' }),
          user({ id: 'u-a', email: 'a@example.com' }),
          user({ id: 'u-z', email: 'z@example.com', roles: [], role: null }),
          user({ id: 'u-b', email: 'b@example.com', roles: [], role: null }),
        ]),
      ),
    );

    const view = render(UserManagement);
    await waitFor(() => {
      expect(view.container.querySelector('table')).not.toBeNull();
    });

    expect(emailsInOrder(view.container)).toEqual([
      'b@example.com',
      'z@example.com',
      'a@example.com',
      'c@example.com',
    ]);
  });

  test('labels roles from the names the server reports', async () => {
    stubFetch(() =>
      Response.json(
        usersResponse([
          user({ id: 'u-a', email: 'a@example.com', roles: ['ops-admin'], role: 'ops-admin' }),
          user({ id: 'u-v', email: 'v@example.com' }),
        ]),
      ),
    );

    const view = render(UserManagement);
    await waitFor(() => {
      expect(view.getAllByText('管理员').length).toBeGreaterThan(0);
    });

    expect(view.getAllByText('查看者').length).toBeGreaterThan(0);
    expect(view.queryByText('ops-admin')).toBeNull();
    expect(view.queryByText('ops-viewer')).toBeNull();
    expect(view.getAllByRole('button', { name: '提升为管理员' }).length).toBeGreaterThan(0);
    expect(view.getAllByRole('button', { name: '降级为查看者' }).length).toBeGreaterThan(0);
  });

  test('offers no role change on the signed-in user own row', async () => {
    stubFetch(() =>
      Response.json(
        usersResponse([
          user({ id: 'auth0|me', email: 'me@example.com' }),
          user({ id: 'auth0|other', email: 'other@example.com' }),
        ]),
      ),
    );

    const view = render(UserManagement, { props: { currentUserId: 'auth0|me' } });
    await waitFor(() => {
      expect(view.container.querySelector('table')).not.toBeNull();
    });

    const rows = Array.from(view.container.querySelectorAll('table tbody tr'));
    const own = rows.find((row) => row.textContent.includes('me@example.com'));
    const other = rows.find((row) => row.textContent.includes('other@example.com'));
    if (!own || !other) throw new Error('rows not rendered');
    expect(own.textContent).toContain('当前登录用户');
    expect(own.querySelectorAll('button')).toHaveLength(0);
    expect(other.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  test('PUTs the new role and reports how many sessions were revoked', async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    globalThis.confirm = () => true;
    stubFetch((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'PUT') {
        calls.push({
          url,
          method: init.method,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        });
        return Response.json(roleResponse({ sessions_revoked: 3 }));
      }
      return Response.json(usersResponse([user({ id: 'auth0|1', email: 'a@example.com' })]));
    });

    const view = render(UserManagement);
    await waitFor(() => {
      expect(view.getAllByRole('button', { name: '提升为管理员' }).length).toBeGreaterThan(0);
    });
    const [promote] = view.getAllByRole('button', { name: '提升为管理员' });
    if (!promote) throw new Error('no promote button rendered');
    await fireEvent.click(promote);

    await waitFor(() => {
      expect(view.getByText(/已注销 3 个会话/)).toBeTruthy();
    });
    expect(calls).toEqual([
      {
        url: 'https://example.com/api/users/auth0%7C1/role',
        method: 'PUT',
        body: { role: 'ops-admin' },
      },
    ]);
  });

  test('shows the server error text when loading fails', async () => {
    stubFetch(() => Response.json({ error: 'Forbidden: users.read required' }, { status: 403 }));

    const view = render(UserManagement);

    await waitFor(() => {
      expect(view.getByText(/Forbidden: users.read required/)).toBeTruthy();
    });
  });
});
