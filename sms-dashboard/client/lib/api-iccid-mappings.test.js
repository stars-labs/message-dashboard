import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { api } from './api.js';
import { auth } from './auth.js';

const originalFetch = globalThis.fetch;
const originalBaseUrl = auth.baseUrl;

beforeEach(() => {
  auth.baseUrl = 'https://example.com';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  auth.baseUrl = originalBaseUrl;
});

function failEveryRequest() {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(`${init?.method ?? 'GET'} ${new URL(String(url), 'https://example.com').pathname}`);
    return Response.json({ error: 'ICCID already mapped' }, { status: 409 });
  };
  return sent;
}

describe('ICCID mapping writes', () => {
  test('a rejected create is sent once and reports the server error', async () => {
    const sent = failEveryRequest();

    const error = await api.iccidMappings.create({ iccid: '8986' }).then(
      () => null,
      (e) => e,
    );

    expect(error?.message).toBe('ICCID already mapped');
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
});
