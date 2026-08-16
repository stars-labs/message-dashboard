const RUNNER_SCOPES = [
  'openid',
  'offline_access',
  'balance:runners:heartbeat',
  'balance:skills:run',
  'balance:browser:run',
];

function issuerUrl(issuer, path) {
  const base = String(issuer || '').trim().replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error('Auth0 issuer must use HTTPS');
  return `${base}${path}`;
}

async function authRequest(url, fields, fetchImpl, signal) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function authError(payload, fallback) {
  const code = typeof payload?.error === 'string' ? payload.error.trim() : '';
  const description = typeof payload?.error_description === 'string'
    ? payload.error_description.trim()
    : '';
  if (code && description) return `${code}: ${description}`;
  return description || code || fallback;
}

export function createAuth0DeviceClient({
  issuer,
  clientId,
  audience,
  fetchImpl = fetch,
  sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }),
}) {
  if (!clientId || !audience) throw new Error('Auth0 client ID and audience are required');

  return Object.freeze({
    async begin({ signal } = {}) {
      const { response, payload } = await authRequest(
        issuerUrl(issuer, '/oauth/device/code'),
        {
          client_id: clientId,
          audience,
          scope: RUNNER_SCOPES.join(' '),
        },
        fetchImpl,
        signal,
      );
      if (!response.ok || !payload.device_code || !payload.user_code) {
        throw new Error(authError(payload, `Could not start device login (${response.status})`));
      }
      return payload;
    },

    async poll(device, { signal, onPending } = {}) {
      let interval = Math.max(1, Number(device.interval) || 5);
      const deadline = Date.now() + Number(device.expires_in || 900) * 1000;
      while (!signal?.aborted && Date.now() < deadline) {
        await sleep(interval * 1000, signal);
        if (signal?.aborted) break;
        const { response, payload } = await authRequest(
          issuerUrl(issuer, '/oauth/token'),
          {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device.device_code,
            client_id: clientId,
          },
          fetchImpl,
          signal,
        );
        if (response.ok && payload.access_token) return payload;
        if (payload.error === 'authorization_pending') {
          onPending?.();
          continue;
        }
        if (payload.error === 'slow_down') {
          interval += 5;
          continue;
        }
        throw new Error(payload.error_description || payload.error || `Device login failed (${response.status})`);
      }
      if (signal?.aborted) throw new Error('Device login cancelled');
      throw new Error('Device login expired');
    },

    async refresh(refreshToken, { signal } = {}) {
      const { response, payload } = await authRequest(
        issuerUrl(issuer, '/oauth/token'),
        {
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshToken,
        },
        fetchImpl,
        signal,
      );
      if (!response.ok || !payload.access_token) {
        throw new Error(payload.error_description || payload.error || `Token refresh failed (${response.status})`);
      }
      return payload;
    },
  });
}

export { RUNNER_SCOPES };
