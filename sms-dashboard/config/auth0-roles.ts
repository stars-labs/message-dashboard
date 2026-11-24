// Auth0 strips unnamespaced custom claims from minted tokens, so the claim must be a full URI.
const DEFAULT_ROLE_CLAIM = 'https://sexy.itoken.world/roles';

const ADMIN = 'admin';
const VIEWER = 'viewer';

type CanonicalRole = typeof ADMIN | typeof VIEWER;

// `viewer` deliberately includes `messages.send`: a viewer can originate SMS from any SIM.
export const ROLE_PERMISSIONS = {
  [VIEWER]: ['bills.read', 'messages.read', 'messages.send', 'phones.read'],
  [ADMIN]: [
    'bills.read',
    'bills.write',
    'messages.read',
    'messages.send',
    'balances.query',
    'phones.read',
    'phones.write',
    'keywords.read',
    'keywords.write',
    'keywords.delete',
    'filters.read',
    'filters.write',
    'filters.delete',
    'users.read',
    'users.write',
  ],
} as const satisfies Record<CanonicalRole, readonly string[]>;

export type Permission = (typeof ROLE_PERMISSIONS)[CanonicalRole][number];

export const ALL_PERMISSIONS: Permission[] = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];

interface RoleConfig {
  ADMIN_ROLE: string;
  VIEWER_ROLE: string;
  ROLE_CLAIM: string;
}

export interface RoleEnv {
  AUTH0_ADMIN_ROLE?: string;
  AUTH0_VIEWER_ROLE?: string;
  AUTH0_ROLE_NAMESPACE?: string;
}

/** An env var set to the empty string counts as unset. */
function configured(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

export function createRoleConfig(env: RoleEnv = {}): RoleConfig {
  return {
    ADMIN_ROLE: configured(env.AUTH0_ADMIN_ROLE, ADMIN),
    VIEWER_ROLE: configured(env.AUTH0_VIEWER_ROLE, VIEWER),
    ROLE_CLAIM: configured(env.AUTH0_ROLE_NAMESPACE, DEFAULT_ROLE_CLAIM),
  };
}

function canonicalRole(role: string, config: RoleConfig): CanonicalRole | null {
  if (role === config.ADMIN_ROLE) return ADMIN;
  if (role === config.VIEWER_ROLE) return VIEWER;
  return null;
}

/** Anything unrecognised, including the retired `sms` role, grants nothing. */
export function permissionsForRoles(roles: unknown, config: RoleConfig): Permission[] {
  if (!Array.isArray(roles)) return [];

  const granted = new Set<Permission>();

  for (const role of roles) {
    const key = typeof role === 'string' ? canonicalRole(role, config) : null;
    if (!key) continue;
    for (const permission of ROLE_PERMISSIONS[key]) granted.add(permission);
  }

  return [...granted];
}

export function hasAnyRole(roles: unknown, config: RoleConfig): boolean {
  return permissionsForRoles(roles, config).length > 0;
}

/** Reads only the namespaced claim; a top-level `roles` claim is attacker-influenceable. */
export function rolesFromToken(
  payload: Record<string, unknown> | null | undefined,
  config: RoleConfig,
): string[] {
  if (!payload) return [];
  const claim = payload[config.ROLE_CLAIM];
  return Array.isArray(claim) ? claim.filter((r): r is string => typeof r === 'string') : [];
}

export function getKnownRoles(config: RoleConfig): string[] {
  return [config.ADMIN_ROLE, config.VIEWER_ROLE];
}

interface EmailAllowedResult {
  allowed: boolean;
  reason: string | null;
  domain: string | null;
}

interface Profile {
  email?: unknown;
  email_verified?: unknown;
}

/**
 * The address must be email_verified: Auth0 database connections set it false until the
 * user confirms, so without the check anyone could sign up as x@allowed-domain.
 * The domain is taken after the final '@' and matched whole, never by substring or suffix.
 */
export function isEmailAllowed(
  profile: Profile | null | undefined,
  env: { ALLOWED_EMAIL_DOMAINS?: string } = {},
): EmailAllowedResult {
  const email = typeof profile?.email === 'string' ? profile.email : '';

  if (!email) {
    return { allowed: false, reason: 'No email address on profile', domain: null };
  }

  if (profile?.email_verified !== true) {
    return { allowed: false, reason: 'Email address is not verified', domain: null };
  }

  const domain = email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();

  if (!domain || !email.includes('@')) {
    return { allowed: false, reason: 'Malformed email address', domain: null };
  }

  const allowedDomains = (env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  // No list configured means no domain restriction; the role check remains the gate.
  if (allowedDomains.length === 0) {
    return { allowed: true, reason: null, domain };
  }

  if (!allowedDomains.includes(domain)) {
    return { allowed: false, reason: 'Email domain not allowed', domain };
  }

  return { allowed: true, reason: null, domain };
}
