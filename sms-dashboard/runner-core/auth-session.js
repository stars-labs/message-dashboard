import { assertRunnerAccessToken } from './access-token.js';
import { createAuth0DeviceClient } from './auth0-device.js';

export function createAuthSession({
  getConfiguration,
  secureStore,
  fetchImpl = fetch,
  sleep,
}) {
  let accessToken = null;
  let accessTokenExpiresAt = 0;

  function configuration() {
    const value = getConfiguration();
    return {
      issuer: String(value?.auth0Issuer || '').trim(),
      clientId: String(value?.auth0ClientId || '').trim(),
      audience: String(value?.auth0Audience || '').trim(),
    };
  }

  function client() {
    return createAuth0DeviceClient({ ...configuration(), fetchImpl, ...(sleep ? { sleep } : {}) });
  }

  async function rememberTokens(payload) {
    assertRunnerAccessToken(payload.access_token, configuration().audience);
    accessToken = payload.access_token;
    accessTokenExpiresAt = Date.now() + Math.max(0, Number(payload.expires_in || 0) - 60) * 1000;
    if (payload.refresh_token) await secureStore.set('auth0RefreshToken', payload.refresh_token);
  }

  return Object.freeze({
    async hasRefreshToken() {
      return Boolean(await secureStore.get('auth0RefreshToken'));
    },

    async getAccessToken({ signal } = {}) {
      if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
      const refreshToken = await secureStore.get('auth0RefreshToken');
      if (!refreshToken) throw new Error('Balance Agent is not signed in');
      const payload = await client().refresh(refreshToken, { signal });
      await rememberTokens(payload);
      return accessToken;
    },

    async signIn({ signal, onDeviceCode } = {}) {
      const authClient = client();
      const device = await authClient.begin({ signal });
      await onDeviceCode?.({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        verificationUriComplete: device.verification_uri_complete,
      });
      const payload = await authClient.poll(device, { signal });
      await rememberTokens(payload);
      return payload;
    },

    async signOut() {
      await secureStore.set('auth0RefreshToken', null);
      accessToken = null;
      accessTokenExpiresAt = 0;
    },
  });
}
