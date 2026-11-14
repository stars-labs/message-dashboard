// Run with: bun test server/middleware/rbac.test.ts
//
// These tests pin the authorization model closed. The bug they were written for:
// USE_AUTH0_ROLES="false" made requirePermission() return undefined (= allow) for
// every permission, and enrichUserPermissions() explicitly granted the full
// permission list to everyone. See docs/SECURITY-REVIEW.md finding 1.
import { describe, expect, test } from 'bun:test';
import { enrichUserPermissions, requirePermission, type PermissionRequest } from './rbac.js';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '../../config/auth0-roles.js';

function req(
  user: NonNullable<PermissionRequest['user']>,
  envOverrides: Record<string, string | undefined> = {},
): PermissionRequest {
  return { user, env: { ...envOverrides } };
}

// requirePermission returns undefined to allow, or a Response to deny.
function isAllowed(request: PermissionRequest, permission: Permission): boolean {
  return requirePermission(permission)(request) === undefined;
}

function denial(request: PermissionRequest, permission: Permission): Response {
  const result = requirePermission(permission)(request);
  if (result === undefined) throw new Error(`${permission} was allowed`);
  return result;
}

function enrichedPermissions(
  user: NonNullable<PermissionRequest['user']>,
  envOverrides: Record<string, string | undefined> = {},
): string[] | undefined {
  const request = req(user, envOverrides);
  enrichUserPermissions(request);
  return request.user?.permissions;
}

describe('requirePermission — unauthenticated', () => {
  test('denies with 401 when there is no user', () => {
    const result = requirePermission('messages.read')({ env: {} });
    expect(result).toBeInstanceOf(Response);
    expect(result?.status).toBe(401);
  });
});

// The full matrix. Every permission is decided for every role, so adding a permission
// to a route without adding it to the role map fails loudly here.
describe('requirePermission — admin/viewer matrix', () => {
  const matrix: [string, readonly string[]][] = Object.entries(ROLE_PERMISSIONS);
  for (const [role, expected] of matrix) {
    for (const permission of ALL_PERMISSIONS) {
      const shouldAllow = expected.includes(permission);

      test(`${role} ${shouldAllow ? 'may' : 'may NOT'} ${permission}`, () => {
        expect(isAllowed(req({ roles: [role] }), permission)).toBe(shouldAllow);
      });
    }
  }
});

describe('requirePermission — viewer restrictions', () => {
  const viewer = () => req({ roles: ['viewer'] });

  test('viewer can read messages, phones, and bills and send messages', () => {
    expect(isAllowed(viewer(), 'messages.read')).toBe(true);
    expect(isAllowed(viewer(), 'phones.read')).toBe(true);
    expect(isAllowed(viewer(), 'bills.read')).toBe(true);
    expect(isAllowed(viewer(), 'messages.send')).toBe(true);
  });

  // P0 regression: routes use phones.write, which the old permission list omitted.
  test('viewer is denied phones.write with 403', () => {
    const result = denial(viewer(), 'phones.write');
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);
  });

  test('viewer is denied every admin-only permission', () => {
    const adminOnly: Permission[] = [
      'phones.write',
      'bills.write',
      'keywords.read',
      'keywords.write',
      'keywords.delete',
      'filters.read',
      'filters.write',
      'filters.delete',
      'users.read',
      'users.write',
    ];
    for (const p of adminOnly) {
      expect(isAllowed(viewer(), p)).toBe(false);
    }
  });
});

describe('requirePermission — admin', () => {
  test('admin is allowed phones.write (the regression case)', () => {
    expect(isAllowed(req({ roles: ['admin'] }), 'phones.write')).toBe(true);
  });

  test('admin is allowed every known permission', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(isAllowed(req({ roles: ['admin'] }), p)).toBe(true);
    }
  });
});

describe('requirePermission — roleless and unknown roles', () => {
  test('denies a user with no roles', () => {
    expect(denial(req({ roles: [] }), 'messages.read').status).toBe(403);
  });

  test('names the roles that would grant access when the user holds none', async () => {
    const body = await denial(req({ roles: [] }), 'messages.read').json();
    expect(body).toEqual({
      error: 'Forbidden',
      message: 'You need one of these roles to access this system: admin, viewer',
    });
  });

  test('names the missing permission when the user holds some other grant', async () => {
    const body = await denial(req({ roles: ['viewer'] }), 'phones.write').json();
    expect(body).toEqual({
      error: 'Forbidden',
      message: "Your role does not grant 'phones.write'",
    });
  });

  test('denies a user holding only an unrelated role', () => {
    expect(isAllowed(req({ roles: ['billing'] }), 'messages.read')).toBe(false);
  });

  // Sessions minted before the split carry roles: ['sms'], which now grants nothing.
  test('denies the retired sms role', () => {
    expect(isAllowed(req({ roles: ['sms'] }), 'messages.read')).toBe(false);
  });

  test('denies a non-array roles value without throwing', () => {
    expect(isAllowed(req({ roles: 'admin' }), 'messages.read')).toBe(false);
    expect(isAllowed(req({}), 'messages.read')).toBe(false);
  });
});

// The core of finding 1: the old code keyed off `env.USE_AUTH0_ROLES !== 'false'`, so a
// missing/typo'd/unexpected value silently disabled every check. No env value may
// re-open the gate.
describe('requirePermission — fails closed regardless of env', () => {
  for (const value of ['false', 'FALSE', '0', 'no', '', undefined, 'true', 'yes']) {
    test(`denies a roleless user when USE_AUTH0_ROLES=${JSON.stringify(value)}`, () => {
      const result = denial(req({ roles: [] }, { USE_AUTH0_ROLES: value }), 'messages.read');
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(403);
    });
  }

  test('denies a viewer phones.write even with the old bypass flags set', () => {
    const request = req(
      { roles: ['viewer'] },
      {
        USE_AUTH0_ROLES: 'false',
        AUTH0_ALLOW_NO_ROLES: 'true',
      },
    );
    expect(isAllowed(request, 'phones.write')).toBe(false);
  });

  test('denies a roleless user with no env config at all', () => {
    expect(denial({ user: { roles: [] }, env: {} }, 'messages.read').status).toBe(403);
  });
});

describe('requirePermission — configured role names', () => {
  test('honours renamed Auth0 roles from the env', () => {
    const request = req({ roles: ['staff'] }, { AUTH0_ADMIN_ROLE: 'staff' });
    expect(isAllowed(request, 'phones.write')).toBe(true);
  });
});

describe('enrichUserPermissions', () => {
  test('grants the viewer set to a viewer', () => {
    expect(
      enrichedPermissions({ roles: ['viewer'] })
        ?.slice()
        .sort(),
    ).toEqual([...ROLE_PERMISSIONS.viewer].sort());
  });

  test('grants everything to an admin', () => {
    expect(
      enrichedPermissions({ roles: ['admin'] })
        ?.slice()
        .sort(),
    ).toEqual([...ALL_PERMISSIONS].sort());
  });

  test('grants nothing to a roleless user', () => {
    expect(enrichedPermissions({ roles: [] })).toEqual([]);
  });

  // The old else-branch handed out every permission here.
  test('grants nothing to a roleless user when USE_AUTH0_ROLES=false', () => {
    expect(enrichedPermissions({ roles: [] }, { USE_AUTH0_ROLES: 'false' })).toEqual([]);
  });

  test('grants nothing when the roles claim is missing or malformed', () => {
    for (const user of [{}, { roles: 'admin' }, { roles: null }]) {
      expect(enrichedPermissions(user)).toEqual([]);
    }
  });

  test('leaves a request without a user untouched', () => {
    const request: PermissionRequest = { env: {} };
    enrichUserPermissions(request);
    expect(request).toEqual({ env: {} });
  });
});
