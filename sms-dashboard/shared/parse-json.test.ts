import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { parseJson, readJson } from './parse-json.js';

const Point = v.object({ x: v.number(), y: v.number() });

describe('parseJson', () => {
  test('returns the parsed value when the text matches the schema', () => {
    expect(parseJson('{"x":1,"y":2}', Point)).toEqual({ ok: true, value: { x: 1, y: 2 } });
  });

  test('drops keys the schema does not name', () => {
    expect(parseJson('{"x":1,"y":2,"z":3}', Point)).toEqual({ ok: true, value: { x: 1, y: 2 } });
  });

  test('reports text that is not JSON', () => {
    const result = parseJson('{"x":', Point);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toStartWith('Invalid JSON');
  });

  test('reports JSON that does not match the schema, naming the field', () => {
    const result = parseJson('{"x":"1","y":2}', Point);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('x');
  });
});

describe('readJson', () => {
  test('parses a request body', async () => {
    const request = new Request('https://example.test', { method: 'POST', body: '{"x":1,"y":2}' });
    expect(await readJson(request, Point)).toEqual({ ok: true, value: { x: 1, y: 2 } });
  });

  test('reports a body that is not JSON', async () => {
    const result = await readJson(new Response('not json'), Point);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toStartWith('Invalid JSON');
  });

  test('reports a body that does not match the schema', async () => {
    const result = await readJson(Response.json({ x: 1 }), Point);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('y');
  });
});
