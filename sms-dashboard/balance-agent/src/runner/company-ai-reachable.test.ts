import { describe, expect, test } from 'bun:test';
import {
  companyAIReachable,
  type CompanyAIProbeFetch,
  type CompanyAIRequest,
} from './company-ai.js';

function stubFetch(status: number, { throws = false } = {}) {
  const calls: { url: string; options: CompanyAIRequest }[] = [];
  const impl: CompanyAIProbeFetch = (url, options) => {
    calls.push({ url, options });
    if (throws) return Promise.reject(new Error('fetch failed'));
    return Promise.resolve({ status });
  };
  return { impl, calls };
}

describe('company AI liveness probe', () => {
  test('probes the route callAI uses, not the bare base URL', async () => {
    const fetchImpl = stubFetch(401);
    await companyAIReachable('https://ai.example.com/api/cc', fetchImpl.impl);
    expect(fetchImpl.calls[0]?.url).toBe('https://ai.example.com/api/cc/v1/messages');
    expect(fetchImpl.calls[0]?.options.method).toBe('POST');
  });

  test('treats an auth rejection as reachable', async () => {
    // The gateway answering 401 proves the network path is open.
    expect(await companyAIReachable('https://ai.example.com/api/cc', stubFetch(401).impl)).toBe(
      true,
    );
  });

  test('treats a malformed-body rejection as reachable', async () => {
    expect(await companyAIReachable('https://ai.example.com/api/cc', stubFetch(422).impl)).toBe(
      true,
    );
  });

  test('treats a successful response as reachable', async () => {
    expect(await companyAIReachable('https://ai.example.com/api/cc', stubFetch(200).impl)).toBe(
      true,
    );
  });

  test('treats a missing route as unreachable', async () => {
    expect(await companyAIReachable('https://ai.example.com/api/cc', stubFetch(404).impl)).toBe(
      false,
    );
  });

  test('treats a connection failure as unreachable and reports the error', async () => {
    const errors: unknown[] = [];
    expect(
      await companyAIReachable(
        'https://ai.example.com/api/cc',
        stubFetch(0, { throws: true }).impl,
        (error) => {
          errors.push(error);
        },
      ),
    ).toBe(false);
    expect(errors).toHaveLength(1);
  });

  test('tolerates a trailing slash on the configured base URL', async () => {
    const fetchImpl = stubFetch(200);
    await companyAIReachable('https://ai.example.com/api/cc///', fetchImpl.impl);
    expect(fetchImpl.calls[0]?.url).toBe('https://ai.example.com/api/cc/v1/messages');
  });

  test('waits long enough for the slow gateway, and not forever', async () => {
    // The live gateway answers in ~3.9s. Capture the real abort timing so a
    // regression back to a tight budget fails here instead of in production.
    let abortedAt: number | null = null;
    const fetchImpl: CompanyAIProbeFetch = async (_url, options) => {
      const started = Date.now();
      const signal = options.signal;
      const onAbort = () => {
        abortedAt = Date.now() - started;
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Outlast a 4s gateway response, then clean up.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) throw new Error('aborted');
      return { status: 401 };
    };
    const reachable = await companyAIReachable('https://ai.example.com/api/cc', fetchImpl);
    expect(reachable).toBe(true);
    // It must not have aborted at the old 5s budget boundary mid-flight.
    expect(abortedAt).toBeNull();
  });
});
