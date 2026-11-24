// The HttpOnly `auth_token` cookie wins; the Authorization header (an Auth0 JWT from
// programmatic clients) is consulted only when no cookie is present.

const COOKIE_NAME = 'auth_token';

interface SessionCredential {
  token: string;
  source: 'cookie' | 'header';
}

export function extractSessionToken(
  authHeader: string | null,
  cookieHeader: string | null,
): SessionCredential | null {
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

/** Splits on the first '=' only: values may contain '=' (base64 padding). Names match exactly. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
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
