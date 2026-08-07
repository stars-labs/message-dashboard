// Run with: bun test server/utils/session-token.test.js
import { describe, expect, test } from 'bun:test';
import { extractSessionToken, readCookie } from './session-token.js';

describe('readCookie', () => {
  test('reads a single cookie', () => {
    expect(readCookie('auth_token=abc123', 'auth_token')).toBe('abc123');
  });

  test('reads from a multi-cookie header regardless of position', () => {
    expect(readCookie('a=1; auth_token=abc123; b=2', 'auth_token')).toBe('abc123');
    expect(readCookie('auth_token=abc123; b=2', 'auth_token')).toBe('abc123');
    expect(readCookie('a=1; auth_token=abc123', 'auth_token')).toBe('abc123');
  });

  test('tolerates missing and extra whitespace', () => {
    expect(readCookie('a=1;auth_token=abc123;b=2', 'auth_token')).toBe('abc123');
    expect(readCookie('  auth_token = abc123  ', 'auth_token')).toBe('abc123');
  });

  // A nanoid has no '=', but a value containing one must not be truncated.
  test('preserves = inside the value', () => {
    expect(readCookie('auth_token=YWJjMTIz==', 'auth_token')).toBe('YWJjMTIz==');
  });

  // Prefix/suffix confusion: a lookup must not be satisfied by a similar name.
  test('matches the cookie name exactly', () => {
    expect(readCookie('xauth_token=evil', 'auth_token')).toBeNull();
    expect(readCookie('auth_token_backup=evil', 'auth_token')).toBeNull();
    expect(readCookie('notauth_token=evil; auth_token=real', 'auth_token')).toBe('real');
  });

  test('returns null for absent, empty and malformed headers', () => {
    expect(readCookie('', 'auth_token')).toBeNull();
    expect(readCookie(null, 'auth_token')).toBeNull();
    expect(readCookie(undefined, 'auth_token')).toBeNull();
    expect(readCookie('b=2', 'auth_token')).toBeNull();
    expect(readCookie('auth_token', 'auth_token')).toBeNull();
    expect(readCookie('auth_token=', 'auth_token')).toBeNull();
    expect(readCookie('=orphan', 'auth_token')).toBeNull();
  });
});

describe('extractSessionToken', () => {
  test('prefers the cookie over the Authorization header', () => {
    expect(extractSessionToken('Bearer header-token', 'auth_token=cookie-token')).toEqual({
      token: 'cookie-token',
      source: 'cookie',
    });
  });

  test('falls back to a Bearer header when no cookie is present', () => {
    expect(extractSessionToken('Bearer header-token', null)).toEqual({
      token: 'header-token',
      source: 'header',
    });
    expect(extractSessionToken('Bearer header-token', 'other=1')).toEqual({
      token: 'header-token',
      source: 'header',
    });
  });

  test('returns null when neither is present', () => {
    expect(extractSessionToken(null, null)).toBeNull();
    expect(extractSessionToken('', '')).toBeNull();
  });

  test('ignores a non-Bearer or empty Authorization header', () => {
    expect(extractSessionToken('Basic dXNlcjpwYXNz', null)).toBeNull();
    expect(extractSessionToken('Bearer', null)).toBeNull();
    expect(extractSessionToken('Bearer   ', null)).toBeNull();
    expect(extractSessionToken('bearer lowercase', null)).toBeNull();
  });

  test('trims the bearer token', () => {
    expect(extractSessionToken('Bearer  padded  ', null).token).toBe('padded');
  });
});
