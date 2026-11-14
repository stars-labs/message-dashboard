import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { api } from './api.js';
import { auth } from './auth.js';

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

beforeEach(() => {
  auth.baseUrl = 'https://example.com';
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
});

/** Answers every request with `body` and `status`, recording "METHOD path". */
function answerEveryRequest(body: unknown, status: number): string[] {
  const sent: string[] = [];
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (url: string | URL | Request, init?: RequestInit) => {
        const href = url instanceof Request ? url.url : url;
        sent.push(`${init?.method ?? 'GET'} ${new URL(href).pathname}`);
        return Promise.resolve(Response.json(body, { status }));
      },
      { preconnect: () => undefined },
    ),
  );
  return sent;
}

function failEveryRequest(): string[] {
  return answerEveryRequest({ error: 'ICCID already mapped' }, 409);
}

describe('ICCID mapping writes', () => {
  test('a rejected create is sent once and reports the server error', async () => {
    const sent = failEveryRequest();

    const error = await api.iccidMappings.create({ iccid: '8986' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error instanceof Error ? error.message : error).toBe('ICCID already mapped');
    expect(sent).toEqual(['POST /api/iccid-mappings']);
  });

  test('a rejected update is sent once', async () => {
    const sent = failEveryRequest();

    await api.iccidMappings.update('8986', { number: '+6591234567' }).catch(() => null);

    expect(sent).toEqual(['PUT /api/iccid-mappings/8986']);
  });

  test('a rejected delete is sent once', async () => {
    const sent = failEveryRequest();

    await api.iccidMappings.delete('8986').catch(() => null);

    expect(sent).toEqual(['DELETE /api/iccid-mappings/8986']);
  });

  test('a failed list is requested once', async () => {
    const sent = failEveryRequest();

    await api.iccidMappings.list({}).catch(() => null);

    expect(sent).toEqual(['GET /api/iccid-mappings']);
  });

  test('a delete the server confirms resolves with its answer', async () => {
    answerEveryRequest({ success: true, message: 'ICCID mapping deleted successfully' }, 200);

    expect(await api.iccidMappings.delete('8986')).toEqual({
      success: true,
      message: 'ICCID mapping deleted successfully',
    });
  });
});
