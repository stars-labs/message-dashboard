export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface ControlRequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  signal?: AbortSignal | null | undefined;
  timeout?: number;
}

export interface ControlClient {
  request(path: string, options?: ControlRequestOptions): Promise<Response>;
}

function normalizedBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Runner API base URL must use HTTP or HTTPS');
  return baseUrl;
}

function requestSignal(timeout: number, signal: AbortSignal | null | undefined): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
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

  return Object.freeze({
    async request(path: string, options: ControlRequestOptions = {}): Promise<Response> {
      const { timeout = defaultTimeout, signal, ...fetchOptions } = options;
      const url = new URL(path, `${normalizedUrl}/`).toString();
      return fetchImpl(url, {
        ...fetchOptions,
        headers: {
          ...(await authorizationHeaders()),
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: requestSignal(timeout, signal),
      });
    },
  });
}
