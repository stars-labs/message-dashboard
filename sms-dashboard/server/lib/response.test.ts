import { describe, expect, test } from 'bun:test';
import { json } from './response.js';

describe('json', () => {
  test('answers the body as JSON with status 200', async () => {
    const response = json({ ok: true, items: [1, 2] });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toStartWith('application/json');
    expect(await response.json()).toEqual({ ok: true, items: [1, 2] });
  });

  test('answers the given status', async () => {
    const response = json({ error: 'Not Found' }, 404);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  test('adds the given headers alongside the JSON content type', () => {
    const response = json({}, 200, { 'Cache-Control': 'no-store' });

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toStartWith('application/json');
  });
});
