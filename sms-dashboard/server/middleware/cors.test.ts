import { describe, expect, test } from 'bun:test';
import { corsPreflight, handleCORS } from './cors.js';

describe('handleCORS', () => {
  test('adds the CORS headers to a response and keeps status, body and its own headers', async () => {
    const original = new Response('{"ok":true}', {
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'application/json' },
    });

    const response = handleCORS(original);

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, DELETE, OPTIONS',
    );
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type, Authorization, X-API-Key, Upgrade, Connection',
    );
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  test('overrides a CORS header the response already carried', () => {
    const response = handleCORS(
      new Response(null, { headers: { 'Access-Control-Allow-Origin': 'https://example.com' } }),
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('answers a preflight with 204 when given no response', async () => {
    for (const response of [handleCORS(), handleCORS(null)]) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    }
  });
});

describe('corsPreflight', () => {
  test('is the 204 preflight answer', () => {
    const response = corsPreflight();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
      'GET, POST, PUT, DELETE, OPTIONS',
    );
  });
});
