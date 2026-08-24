// Run with: bun test server/middleware/rbac.test.js
//
// These tests pin the authorization model closed. The bug they were written for:
// USE_AUTH0_ROLES="false" made requirePermission() return undefined (= allow) for
// every permission, and enrichUserPermissions() explicitly granted the full
// permission list to everyone. See docs/SECURITY-REVIEW.md finding 1.
import { describe, expect, test } from 'bun:test';
import { enrichUserPermissions, requirePermission } from './rbac.js';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../../config/auth0-roles.js';

function req(user, envOverrides = {}) {
  return { user, env: { ...envOverrides } };
}

// requirePermission returns undefined to allow, or a Response to deny.
async function isAllowed(request, permission) {
  const result = await requirePermission(permission)(request);
  return result === undefined;
}

describe('requirePermission — unauthenticated', () => {
  test('denies with 401 when there is no user', async () => {
    const result = await requirePermission('messages.read')({ user: null, env: {} });
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(401);
  });
});

// The full matrix. Every permission is decided for every role, so adding a permission
// to a route without adding it to the role map fails loudly here.
describe('requirePermission — admin/viewer matrix', () => {
  for (const [role, expected] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of ALL_PERMISSIONS) {
      const shouldAllow = expected.includes(permission);

      test(`${role} ${shouldAllow ? 'may' : 'may NOT'} ${permission}`, async () => {
        expect(await isAllowed(req({ roles: [role] }), permission)).toBe(shouldAllow);
      });
    }
  }
});

describe('requirePermission — viewer restrictions', () => {
  const viewer = () => req({ roles: ['viewer'] });

  test('viewer can read messages, phones, and bills and send messages', async () => {
    expect(await isAllowed(viewer(), 'messages.read')).toBe(true);
    expect(await isAllowed(viewer(), 'phones.read')).toBe(true);
    expect(await isAllowed(viewer(), 'bills.read')).toBe(true);
    expect(await isAllowed(viewer(), 'messages.send')).toBe(true);
  });

  // P0 regression: routes use phones.write, which the old permission list omitted.
  test('viewer is denied phones.write with 403', async () => {
    const result = await requirePermission('phones.write')(viewer());
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);
  });

  test('viewer is denied every admin-only permission', async () => {
    for (const p of [
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
    ]) {
      expect(await isAllowed(viewer(), p)).toBe(false);
    }
  });
});

describe('requirePermission — admin', () => {
  test('admin is allowed phones.write (the regression case)', async () => {
    expect(await isAllowed(req({ roles: ['admin'] }), 'phones.write')).toBe(true);
  });

  test('admin is allowed every known permission', async () => {
    for (const p of ALL_PERMISSIONS) {
      expect(await isAllowed(req({ roles: ['admin'] }), p)).toBe(true);
    }
  });
});

describe('requirePermission — roleless and unknown roles', () => {
  test('denies a user with no roles', async () => {
    const result = await requirePermission('messages.read')(req({ roles: [] }));
    expect(result.status).toBe(403);
  });

  test('denies a user holding only an unrelated role', async () => {
    expect(await isAllowed(req({ roles: ['billing'] }), 'messages.read')).toBe(false);
  });

  // Sessions minted before the split carry roles: ['sms'], which now grants nothing.
  test('denies the retired sms role', async () => {
    expect(await isAllowed(req({ roles: ['sms'] }), 'messages.read')).toBe(false);
  });

  test('denies a non-array roles value without throwing', async () => {
    expect(await isAllowed(req({ roles: 'admin' }), 'messages.read')).toBe(false);
    expect(await isAllowed(req({}), 'messages.read')).toBe(false);
  });
});

// The core of finding 1: the old code keyed off `env.USE_AUTH0_ROLES !== 'false'`, so a
// missing/typo'd/unexpected value silently disabled every check. No env value may
// re-open the gate.
describe('requirePermission — fails closed regardless of env', () => {
  for (const value of ['false', 'FALSE', '0', 'no', '', undefined, 'true', 'yes']) {
    test(`denies a roleless user when USE_AUTH0_ROLES=${JSON.stringify(value)}`, async () => {
      const result = await requirePermission('messages.read')(
        req({ roles: [] }, { USE_AUTH0_ROLES: value })
      );
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(403);
    });
  }

  test('denies a viewer phones.write even with the old bypass flags set', async () => {
    const request = req({ roles: ['viewer'] }, {
      USE_AUTH0_ROLES: 'false',
      AUTH0_ALLOW_NO_ROLES: 'true',
    });
    expect(await isAllowed(request, 'phones.write')).toBe(false);
  });

  test('denies a roleless user with no env config at all', async () => {
    const result = await requirePermission('messages.read')({ user: { roles: [] }, env: {} });
    expect(result.status).toBe(403);
  });
});

describe('requirePermission — unknown permissions', () => {
  test('denies a permission outside the known set even for an admin', async () => {
    const result = await requirePermission('admin.destroy')(req({ roles: ['admin'] }));
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ message: expect.stringContaining('Unknown permission') });
  });
});

describe('enrichUserPermissions', () => {
  test('grants the viewer set to a viewer', async () => {
    const request = req({ roles: ['viewer'] });
    await enrichUserPermissions(request);
    expect(request.user.permissions.sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
  });

  test('grants everything to an admin', async () => {
    const request = req({ roles: ['admin'] });
    await enrichUserPermissions(request);
    expect(request.user.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  test('grants nothing to a roleless user', async () => {
    const request = req({ roles: [] });
    await enrichUserPermissions(request);
    expect(request.user.permissions).toEqual([]);
  });

  // The old else-branch handed out every permission here.
  test('grants nothing to a roleless user when USE_AUTH0_ROLES=false', async () => {
    const request = req({ roles: [] }, { USE_AUTH0_ROLES: 'false' });
    await enrichUserPermissions(request);
    expect(request.user.permissions).toEqual([]);
  });

  test('grants nothing when the roles claim is missing or malformed', async () => {
    for (const user of [{}, { roles: 'admin' }, { roles: null }]) {
      const request = req(user);
      await enrichUserPermissions(request);
      expect(request.user.permissions).toEqual([]);
    }
  });
});
