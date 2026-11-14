import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as v from 'valibot';
import { ApiError, api, errorMessage, request } from './api.js';
import { auth } from './auth.js';

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;
let logoutSpy: ReturnType<typeof spyOn<typeof auth, 'logout'>>;

beforeEach(() => {
  auth.baseUrl = 'https://example.com';
  logoutSpy = spyOn(auth, 'logout').mockImplementation(() => undefined);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  logoutSpy.mockRestore();
  auth.baseUrl = originalBaseUrl;
});

/** Answers with `response` and records each request the client made. */
function answer(response: () => Response): Request[] {
  const requests: Request[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(url, init));
        return Promise.resolve(response());
      },
      { preconnect: () => undefined },
    ),
  );
  return requests;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

const Ok = v.object({ ok: v.literal(true) });

describe('request', () => {
  test('parses the answer with the schema and sends the session cookie', async () => {
    const requests = answer(() => Response.json({ ok: true, extra: 1 }));

    expect(await request('/api/thing', Ok)).toEqual({ ok: true });
    expect(requests[0]?.url).toBe('https://example.com/api/thing');
    expect(requests[0]?.credentials).toBe('same-origin');
    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
  });

  test('keeps the headers the caller passed, in any form', async () => {
    const requests = answer(() => Response.json({ ok: true }));

    await request('/api/thing', Ok, { headers: new Headers({ 'X-Trace': 'a' }) });
    await request('/api/thing', Ok, { headers: [['Content-Type', 'text/plain']] });

    expect(requests[0]?.headers.get('X-Trace')).toBe('a');
    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
    expect(requests[1]?.headers.get('Content-Type')).toBe('text/plain');
  });

  test('signs out and fails on 401', async () => {
    answer(() => Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const error = await failureOf(request('/api/thing', Ok));

    expect(error).toBeInstanceOf(ApiError);
    expect(error instanceof ApiError ? [error.status, error.message] : null).toEqual([
      401,
      'Authentication required',
    ]);
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  test('reports the server error, with its detail when there is one', async () => {
    answer(() =>
      Response.json({ error: 'Upstream failed', detail: 'missing scope' }, { status: 502 }),
    );
    const error = await failureOf(request('/api/thing', Ok));
    expect(error instanceof ApiError ? [error.status, error.message] : null).toEqual([
      502,
      'Upstream failed: missing scope',
    ]);
  });

  test('names the status when the error body says nothing usable', async () => {
    answer(() => Response.json({ error: '' }, { status: 500 }));
    const blank = await failureOf(request('/api/thing', Ok));
    expect(blank instanceof Error ? blank.message : null).toBe('Request failed with status 500');

    answer(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const html = await failureOf(request('/api/thing', Ok));
    expect(html instanceof Error ? html.message : null).toBe('Unknown error');
  });

  test('fails on an answer that does not match the schema', async () => {
    answer(() => Response.json({ ok: 'yes' }));

    const error = await failureOf(request('/api/thing', Ok));

    expect(error).toBeInstanceOf(ApiError);
    expect(error instanceof Error ? error.message : '').toStartWith(
      'Unexpected response from /api/thing:',
    );
  });
});

describe('getBalanceChecks', () => {
  test('leaves unset parameters out of the query and falls back to none on failure', async () => {
    const requests = answer(() => Response.json({ error: 'down' }, { status: 503 }));

    expect(await api.getBalanceChecks({ phone_iccid: undefined, limit: 1 })).toEqual([]);
    expect(requests[0]?.url).toBe('https://example.com/api/balance-checks?limit=1');
  });
});

describe('errorMessage', () => {
  test('is the message of an error', () => {
    expect(errorMessage(new ApiError('Keyword already exists', 409), '保存失败')).toBe(
      'Keyword already exists',
    );
  });

  test('is the fallback for an error without a message, or a thrown non-error', () => {
    expect(errorMessage(new Error(''), '保存失败')).toBe('保存失败');
    expect(errorMessage('boom', '保存失败')).toBe('保存失败');
  });
});
