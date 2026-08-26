// Run with: bun test config/auth0-roles.test.js
import { describe, expect, test } from 'bun:test';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  createRoleConfig,
  hasAnyRole,
  isEmailAllowed,
  permissionsForRoles,
  rolesFromToken,
} from './auth0-roles.js';

const CLAIM = 'https://sexy.itoken.world/roles';
const config = createRoleConfig({});

describe('createRoleConfig', () => {
  test('defaults to admin/viewer role names and the namespaced claim URI', () => {
    expect(config.ADMIN_ROLE).toBe('admin');
    expect(config.VIEWER_ROLE).toBe('viewer');
    expect(config.ROLE_CLAIM).toBe(CLAIM);
  });

  test('role names are overridable', () => {
    const c = createRoleConfig({ AUTH0_ADMIN_ROLE: 'superuser', AUTH0_VIEWER_ROLE: 'readonly' });
    expect(c.ADMIN_ROLE).toBe('superuser');
    expect(c.VIEWER_ROLE).toBe('readonly');
  });
});

describe('rolesFromToken', () => {
  test('reads the namespaced claim', () => {
    expect(rolesFromToken({ [CLAIM]: ['admin'] }, config)).toEqual(['admin']);
  });

  // Finding 5: the unnamespaced claim must be ignored entirely, because Auth0 only
  // guarantees that *namespaced* claims cannot be set by the user.
  test('ignores a top-level roles claim', () => {
    expect(rolesFromToken({ roles: ['admin'] }, config)).toEqual([]);
    expect(rolesFromToken({ roles: ['admin'], other: 1 }, config)).toEqual([]);
  });

  test('returns [] for a non-array claim', () => {
    expect(rolesFromToken({ [CLAIM]: 'admin' }, config)).toEqual([]);
    expect(rolesFromToken({ [CLAIM]: { role: 'admin' } }, config)).toEqual([]);
  });

  test('drops non-string entries', () => {
    expect(rolesFromToken({ [CLAIM]: ['admin', 42, null] }, config)).toEqual(['admin']);
  });

  test('returns [] for null/empty payloads', () => {
    expect(rolesFromToken(null, config)).toEqual([]);
    expect(rolesFromToken(undefined, config)).toEqual([]);
    expect(rolesFromToken({}, config)).toEqual([]);
  });
});

describe('permissionsForRoles', () => {
  test('viewer gets read messages, phones, and bills plus message sending', () => {
    expect(permissionsForRoles(['viewer'], config).sort()).toEqual(
      ['bills.read', 'messages.read', 'messages.send', 'phones.read'].sort()
    );
  });

  test('admin gets every permission', () => {
    expect(permissionsForRoles(['admin'], config).sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  test('roles are additive and deduplicated', () => {
    const both = permissionsForRoles(['viewer', 'admin'], config);
    expect(both.sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(both).size).toBe(both.length);
  });

  test('grants nothing for absent, empty, unknown or non-array roles', () => {
    for (const roles of [[], undefined, null, 'admin', { 0: 'admin' }, ['nonsense'], ['sms']]) {
      expect(permissionsForRoles(roles, config)).toEqual([]);
    }
  });

  test('honours renamed roles', () => {
    const c = createRoleConfig({ AUTH0_ADMIN_ROLE: 'superuser' });
    expect(permissionsForRoles(['superuser'], c).sort()).toEqual([...ALL_PERMISSIONS].sort());
    // The default name must no longer work once renamed.
    expect(permissionsForRoles(['admin'], c)).toEqual([]);
  });

  // The old `sms` role is gone; existing sessions carrying it must grant nothing.
  test('the retired sms role grants nothing', () => {
    expect(permissionsForRoles(['sms'], config)).toEqual([]);
  });
});

// P0 regression: routes use `phones.write` but the old SMS_PERMISSIONS list omitted it,
// so it silently fell through the includes() wrapper. It must be a known permission,
// admin-only.
describe('permission coverage', () => {
  const USED_BY_ROUTES = [
    'phones.read',
    'phones.write',
    'messages.read',
    'messages.send',
    'balances.query',
    'bills.read',
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

  for (const permission of USED_BY_ROUTES) {
    test(`${permission} is a known permission`, () => {
      expect(ALL_PERMISSIONS).toContain(permission);
    });
  }

  test('phones.write is granted to admin and denied to viewer', () => {
    expect(permissionsForRoles(['admin'], config)).toContain('phones.write');
    expect(permissionsForRoles(['viewer'], config)).not.toContain('phones.write');
  });

  test('balances.query is granted to admin and denied to viewer', () => {
    expect(permissionsForRoles(['admin'], config)).toContain('balances.query');
    expect(permissionsForRoles(['viewer'], config)).not.toContain('balances.query');
  });

  test('bills are readable by both roles and writable only by admin', () => {
    expect(permissionsForRoles(['admin'], config)).toContain('bills.read');
    expect(permissionsForRoles(['admin'], config)).toContain('bills.write');
    expect(permissionsForRoles(['viewer'], config)).toContain('bills.read');
    expect(permissionsForRoles(['viewer'], config)).not.toContain('bills.write');
  });

  test('viewer cannot reach any write permission', () => {
    const viewerPerms = permissionsForRoles(['viewer'], config);
    for (const p of ['balances.query', 'bills.write', 'phones.write', 'keywords.write', 'keywords.delete', 'filters.write', 'filters.delete', 'users.read', 'users.write']) {
      expect(viewerPerms).not.toContain(p);
    }
  });

  test('ALL_PERMISSIONS is exactly the union of the role map, with no strays', () => {
    const union = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect([...union].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe('hasAnyRole', () => {
  test('true for a recognised role', () => {
    expect(hasAnyRole(['admin'], config)).toBe(true);
    expect(hasAnyRole(['viewer'], config)).toBe(true);
  });

  test('false for empty, missing, non-array and unrecognised roles', () => {
    expect(hasAnyRole([], config)).toBe(false);
    expect(hasAnyRole(undefined, config)).toBe(false);
    expect(hasAnyRole('admin', config)).toBe(false);
    expect(hasAnyRole(['billing'], config)).toBe(false);
    expect(hasAnyRole(['sms'], config)).toBe(false);
  });
});

// The domain allowlist is a real gate, so it has to resist the obvious dodges.
describe('isEmailAllowed', () => {
  const env = { ALLOWED_EMAIL_DOMAINS: 'poloniex.com,bitgc.io,tron.network,htx-inc.com' };
  const ok = (email, verified = true) => isEmailAllowed({ email, email_verified: verified }, env);

  test('allows a verified address on each configured domain', () => {
    for (const d of ['poloniex.com', 'bitgc.io', 'tron.network', 'htx-inc.com']) {
      expect(ok(`someone@${d}`).allowed).toBe(true);
    }
  });

  test('denies a domain not on the list', () => {
    expect(ok('someone@gmail.com').allowed).toBe(false);
  });

  test('compares domains case-insensitively', () => {
    expect(ok('Someone@Poloniex.COM').allowed).toBe(true);
  });

  test('requires a verified email', () => {
    const result = ok('someone@poloniex.com', false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/verified/i);
  });

  test('treats a missing email_verified claim as unverified', () => {
    expect(isEmailAllowed({ email: 'someone@poloniex.com' }, env).allowed).toBe(false);
  });

  test('denies look-alike and subdomain variants', () => {
    expect(ok('a@evil-poloniex.com').allowed).toBe(false);
    expect(ok('a@poloniex.com.evil.io').allowed).toBe(false);
    expect(ok('a@sub.poloniex.com').allowed).toBe(false);
  });

  test('uses the domain after the final @', () => {
    expect(ok('a@poloniex.com@evil.io').allowed).toBe(false);
  });

  test('denies malformed or absent addresses instead of throwing', () => {
    expect(isEmailAllowed({ email: undefined, email_verified: true }, env).allowed).toBe(false);
    expect(isEmailAllowed({ email: 'no-at-sign', email_verified: true }, env).allowed).toBe(false);
    expect(isEmailAllowed({ email: 'trailing@', email_verified: true }, env).allowed).toBe(false);
    expect(isEmailAllowed({}, env).allowed).toBe(false);
    expect(isEmailAllowed(null, env).allowed).toBe(false);
  });

  test('allows any verified address when the list is unset', () => {
    expect(isEmailAllowed({ email: 'a@gmail.com', email_verified: true }, {}).allowed).toBe(true);
  });

  test('still requires verification when the list is unset', () => {
    expect(isEmailAllowed({ email: 'a@gmail.com', email_verified: false }, {}).allowed).toBe(false);
  });
});
