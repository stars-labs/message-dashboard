import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { ApiError, api, contractApi, errorMessage } from './api.js';
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

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function answer(response: () => Response): Sent[] {
  const requests: Sent[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: new Request(url).url, init });
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

const phones = () => contractApi.messages.phones();

describe('contractApi', () => {
  test('sends the session cookie and checks the answer against the contract', async () => {
    const requests = answer(() => Response.json({ success: true, data: [] }));

    expect(await phones()).toEqual({ success: true, data: [] });
    expect(requests[0]?.url).toBe('https://example.com/api/phones');
    expect(requests[0]?.init?.credentials).toBe('same-origin');
  });

  test('signs out and fails on 401', async () => {
    answer(() => Response.json({ error: 'Unauthorized' }, { status: 401 }));

    const error = await failureOf(phones());

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
    const error = await failureOf(phones());
    expect(error instanceof ApiError ? [error.status, error.message] : null).toEqual([
      502,
      'Upstream failed: missing scope',
    ]);
  });

  test('reports a problem by its title and detail', async () => {
    answer(() =>
      Response.json(
        { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'needs phones.read' },
        { status: 403 },
      ),
    );
    const error = await failureOf(phones());
    expect(error instanceof ApiError ? [error.status, error.message] : null).toEqual([
      403,
      'Forbidden: needs phones.read',
    ]);
  });

  test('names the status when the error body says nothing usable', async () => {
    answer(() => Response.json({ error: '' }, { status: 500 }));
    const blank = await failureOf(phones());
    expect(blank instanceof Error ? blank.message : null).toBe('Request failed with status 500');

    answer(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const html = await failureOf(phones());
    expect(html instanceof Error ? html.message : null).toBe('Unknown error');
  });

  test('fails on an answer that does not match the contract', async () => {
    answer(() => Response.json({ success: true, data: 'none' }));

    expect(await failureOf(phones())).toBeInstanceOf(Error);
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
