// Auth0 Role Configuration
// Single source of truth for the role -> permission mapping and for where the roles
// claim is read from. The JWT middleware, the login callback and the page gate in
// index.js all go through here so they cannot drift apart.

/**
 * AUTH0_ROLE_NAMESPACE is the FULL claim URI, e.g. "https://sexy.qzz.io/roles".
 * Auth0 requires custom claims to be namespaced; unnamespaced claims are stripped
 * from minted tokens, which is exactly the property that makes them trustworthy.
 */
const DEFAULT_ROLE_CLAIM = 'https://sexy.qzz.io/roles';

const ADMIN = 'admin';
const VIEWER = 'viewer';

/**
 * What each role may do. Roles are additive: a user's permissions are the union over
 * their roles.
 *
 * `viewer` deliberately includes `messages.send` — a viewer can originate SMS from any
 * SIM. That was an explicit product decision, not an oversight; see
 * docs/SECURITY-REVIEW.md.
 *
 * Every permission string used by any route must appear here, or `requirePermission`
 * will deny it. `phones.write` was previously missing from the permission list while
 * routes used it, which made every ICCID-mapping write fall through the old
 * `includes()` wrapper unchecked.
 */
export const ROLE_PERMISSIONS = {
  [VIEWER]: [
    'messages.read',
    'messages.send',
    'phones.read',
  ],
  [ADMIN]: [
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
};

/** Every permission the system recognises. Anything else denies. */
export const ALL_PERMISSIONS = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];

// Create config from environment variables
export function createRoleConfig(env = {}) {
  return {
    ADMIN_ROLE: env.AUTH0_ADMIN_ROLE || ADMIN,
    VIEWER_ROLE: env.AUTH0_VIEWER_ROLE || VIEWER,

    // Full claim URI the roles array is read from.
    ROLE_CLAIM: env.AUTH0_ROLE_NAMESPACE || DEFAULT_ROLE_CLAIM,
  };
}

/**
 * Map the configured role names back to the canonical keys of ROLE_PERMISSIONS, so the
 * permission table stays fixed even when the Auth0 role names are renamed via env.
 */
function canonicalRole(role, config) {
  if (role === config.ADMIN_ROLE) return ADMIN;
  if (role === config.VIEWER_ROLE) return VIEWER;
  return null;
}

/**
 * The permissions granted by a set of Auth0 role names.
 *
 * Returns [] for anything unrecognised — including the retired `sms` role, so sessions
 * minted before the admin/viewer split grant nothing and their holders re-authenticate.
 */
export function permissionsForRoles(roles, config) {
  if (!Array.isArray(roles)) return [];

  const granted = new Set();

  for (const role of roles) {
    const key = typeof role === 'string' ? canonicalRole(role, config) : null;
    if (!key) continue;
    for (const permission of ROLE_PERMISSIONS[key]) granted.add(permission);
  }

  return [...granted];
}

/**
 * Whether these roles grant any access at all — used by the login gate and the page
 * gate, where the question is "may this person in", not "may they do X".
 *
 * There is deliberately no "allow users without roles" escape hatch: the previous
 * AUTH0_ALLOW_NO_ROLES flag turned the entire gate off from an env var.
 */
export function hasAnyRole(roles, config) {
  return permissionsForRoles(roles, config).length > 0;
}

/**
 * Read the roles array out of a verified JWT payload.
 *
 * Reads ONLY the namespaced claim. An earlier version preferred a top-level
 * `payload.roles` and fell back to the namespaced one, which put an
 * attacker-influenceable claim ahead of the trustworthy one — see
 * docs/SECURITY-REVIEW.md finding 5.
 */
export function rolesFromToken(payload, config) {
  if (!payload) return [];
  const claim = payload[config.ROLE_CLAIM];
  return Array.isArray(claim) ? claim.filter((r) => typeof r === 'string') : [];
}

/** The role names that grant access, for error messages and the admin UI. */
export function getKnownRoles(config) {
  return [config.ADMIN_ROLE, config.VIEWER_ROLE];
}

/**
 * Whether this Auth0 profile may complete login, per the ALLOWED_EMAIL_DOMAINS policy.
 *
 * Returns { allowed, reason, domain } so the caller can write a useful audit_logs row
 * and so a lockout can be diagnosed from the reason rather than guessed at.
 *
 * Two properties matter beyond the domain list itself:
 *  - The address must be email_verified. A domain allowlist is only as good as the
 *    claim it reads: Auth0 database connections set email_verified=false until the
 *    user confirms, so without this check anyone could sign up as x@poloniex.com and
 *    inherit the domain's access.
 *  - The domain is taken after the FINAL '@' and compared case-insensitively against
 *    whole domains — never a substring/suffix match, which "poloniex.com.evil.io"
 *    and "evil-poloniex.com" would both defeat.
 */
export function isEmailAllowed(profile, env = {}) {
  const email = typeof profile?.email === 'string' ? profile.email : '';

  if (!email) {
    return { allowed: false, reason: 'No email address on profile', domain: null };
  }

  if (profile.email_verified !== true) {
    return { allowed: false, reason: 'Email address is not verified', domain: null };
  }

  const domain = email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();

  if (!domain || !email.includes('@')) {
    return { allowed: false, reason: 'Malformed email address', domain: null };
  }

  const configured = (env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  // No list configured means no domain restriction; the role check remains the gate.
  if (configured.length === 0) {
    return { allowed: true, reason: null, domain };
  }

  if (!configured.includes(domain)) {
    return { allowed: false, reason: 'Email domain not allowed', domain };
  }

  return { allowed: true, reason: null, domain };
}
