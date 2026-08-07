// Extract the caller's session credential from a request.
//
// Browsers send it as the `auth_token` cookie, which is set HttpOnly/Secure/SameSite=Lax
// by the login callback. The cookie is preferred precisely because JavaScript cannot read
// it: the token used to also be handed to the SPA in a redirect URL query parameter,
// which leaked it via the Referer header, browser history and Workers request logs.
// See docs/SECURITY-REVIEW.md finding 4.
//
// The Authorization header is still accepted so a programmatic client can present an
// Auth0 JWT directly; it is only consulted when no cookie is present.

const COOKIE_NAME = 'auth_token';

/**
 * @param {string|null} authHeader   value of the Authorization header
 * @param {string|null} cookieHeader value of the Cookie header
 * @returns {{token: string, source: 'cookie'|'header'} | null}
 */
export function extractSessionToken(authHeader, cookieHeader) {
  const fromCookie = readCookie(cookieHeader, COOKIE_NAME);
  if (fromCookie) {
    return { token: fromCookie, source: 'cookie' };
  }

  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      return { token, source: 'header' };
    }
  }

  return null;
}

/**
 * Read a single cookie value.
 *
 * Splits on ';' then on the FIRST '=' only — a cookie value may legitimately contain
 * '=' (base64 padding), and `split('=')[1]` would silently truncate it. Names are
 * matched exactly so `xauth_token` or `auth_token_backup` cannot satisfy a lookup for
 * `auth_token`.
 */
export function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq < 1) continue;

    if (pair.slice(0, eq).trim() === name) {
      const value = pair.slice(eq + 1).trim();
      return value || null;
    }
  }

  return null;
}
