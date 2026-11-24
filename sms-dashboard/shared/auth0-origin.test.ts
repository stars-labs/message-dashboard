import { describe, expect, test } from 'bun:test';
import { auth0Origin } from './auth0-origin.js';

describe('auth0Origin', () => {
  test('is HTTPS for an Auth0 tenant', () => {
    expect(auth0Origin('tenant.auth0.com')).toBe('https://tenant.auth0.com');
  });

  test('is plain HTTP for a loopback stand-in, with or without a port', () => {
    expect(auth0Origin('localhost:8788')).toBe('http://localhost:8788');
    expect(auth0Origin('127.0.0.1:8788')).toBe('http://127.0.0.1:8788');
    expect(auth0Origin('localhost')).toBe('http://localhost');
  });

  test('stays HTTPS for a host that only starts like a loopback name', () => {
    expect(auth0Origin('localhost.example.com')).toBe('https://localhost.example.com');
    expect(auth0Origin('127.0.0.1.nip.io')).toBe('https://127.0.0.1.nip.io');
  });
});
