import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { runnerContract } from '../../../shared/api/contract/runner.js';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type ControlClient = ContractRouterClient<typeof runnerContract>;

export class ControlError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Dashboard answered ${String(status)}: ${body.slice(0, 300)}`);
    this.name = 'ControlError';
    this.status = status;
    this.body = body;
  }
}

function normalizedBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Runner API base URL must use HTTP or HTTPS');
  return baseUrl;
}

function requestSignal(timeout: number, signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
}

export function createControlClient({
  baseUrl,
  apiKey = null,
  getAccessToken = null,
  fetchImpl = fetch,
  defaultTimeout = 15_000,
}: {
  baseUrl: string;
  apiKey?: string | null;
  getAccessToken?: (() => Promise<unknown>) | null;
  fetchImpl?: FetchImpl;
  defaultTimeout?: number;
}): ControlClient {
  const normalizedUrl = normalizedBaseUrl(baseUrl);
  if (!apiKey && typeof getAccessToken !== 'function') {
    throw new Error('Runner control client requires an API key or access-token provider');
  }

  async function authorizationHeaders(): Promise<
    { 'X-API-Key': string } | { Authorization: string }
  > {
    if (apiKey) return { 'X-API-Key': apiKey };
    const token = await getAccessToken?.();
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('Runner access-token provider returned no token');
    }
    return { Authorization: `Bearer ${token.trim()}` };
  }

  async function send(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(await authorizationHeaders())) {
      headers.set(name, value);
    }
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      ...(request.body === null ? {} : { body: await request.text() }),
      signal: requestSignal(defaultTimeout, request.signal),
    });
    if (!response.ok) throw new ControlError(response.status, await response.text());
    return response;
  }

  return createORPCClient(
    new OpenAPILink(runnerContract, {
      url: normalizedUrl,
      fetch: (request) => send(request),
      plugins: [new ResponseValidationPlugin(runnerContract)],
    }),
  );
}
