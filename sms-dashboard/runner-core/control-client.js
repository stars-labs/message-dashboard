function normalizedBaseUrl(value) {
  const baseUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('Runner API base URL must use HTTP or HTTPS');
  return baseUrl;
}

function requestSignal(timeout, signal) {
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
}) {
  const normalizedUrl = normalizedBaseUrl(baseUrl);
  if (!apiKey && typeof getAccessToken !== 'function') {
    throw new Error('Runner control client requires an API key or access-token provider');
  }

  async function authorizationHeaders() {
    if (apiKey) return { 'X-API-Key': apiKey };
    const token = await getAccessToken();
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('Runner access-token provider returned no token');
    }
    return { Authorization: `Bearer ${token.trim()}` };
  }

  return Object.freeze({
    async request(path, options = {}) {
      const { timeout = defaultTimeout, signal, headers = {}, ...fetchOptions } = options;
      const url = new URL(path, `${normalizedUrl}/`).toString();
      return fetchImpl(url, {
        ...fetchOptions,
        headers: {
          ...(await authorizationHeaders()),
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        signal: requestSignal(timeout, signal),
      });
    },
  });
}
