import * as v from 'valibot';
import { assertRunnerAccessToken } from './access-token.js';
import { createAuth0DeviceClient, type Tokens } from './auth0-device.js';
import type { FetchImpl } from './control-client.js';
import { numberOr } from './number-or.js';

const Text = v.fallback(v.optional(v.pipe(v.string(), v.trim()), ''), '');

const Configuration = v.object({
  auth0Issuer: Text,
  auth0ClientId: Text,
  auth0Audience: Text,
});

const BLANK_CONFIGURATION = v.parse(Configuration, {});

const RefreshToken = v.pipe(v.string(), v.nonEmpty());

export interface SecureStore {
  get(key: 'auth0RefreshToken'): Promise<unknown>;
  set(key: 'auth0RefreshToken', value: string | null): Promise<void>;
}

interface DeviceCode {
  userCode: string;
  verificationUri: string | undefined;
  verificationUriComplete: string | undefined;
}

export function createAuthSession({
  getConfiguration,
  secureStore,
  fetchImpl = fetch,
  sleep,
}: {
  getConfiguration: () => unknown;
  secureStore: SecureStore;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  let accessToken: string | null = null;
  let accessTokenExpiresAt = 0;

  function configuration() {
    const parsed = v.safeParse(Configuration, getConfiguration());
    return parsed.success ? parsed.output : BLANK_CONFIGURATION;
  }

  function client() {
    const { auth0Issuer, auth0ClientId, auth0Audience } = configuration();
    return createAuth0DeviceClient({
      issuer: auth0Issuer,
      clientId: auth0ClientId,
      audience: auth0Audience,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
    });
  }

  async function rememberTokens(payload: Tokens): Promise<void> {
    assertRunnerAccessToken(payload.access_token, configuration().auth0Audience);
    accessToken = payload.access_token;
    accessTokenExpiresAt = Date.now() + Math.max(0, numberOr(payload.expires_in, 0) - 60) * 1000;
    if (payload.refresh_token) await secureStore.set('auth0RefreshToken', payload.refresh_token);
  }

  return Object.freeze({
    async hasRefreshToken(): Promise<boolean> {
      return Boolean(await secureStore.get('auth0RefreshToken'));
    },

    async getAccessToken({ signal }: { signal?: AbortSignal } = {}): Promise<string> {
      if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
      const refreshToken = v.safeParse(RefreshToken, await secureStore.get('auth0RefreshToken'));
      if (!refreshToken.success) throw new Error('Balance Agent is not signed in');
      const payload = await client().refresh(refreshToken.output, signal ? { signal } : {});
      await rememberTokens(payload);
      return payload.access_token;
    },

    async signIn({
      signal,
      onDeviceCode,
    }: {
      signal?: AbortSignal;
      onDeviceCode?: (device: DeviceCode) => unknown;
    } = {}): Promise<Tokens> {
      const authClient = client();
      const options = signal ? { signal } : {};
      const device = await authClient.begin(options);
      await onDeviceCode?.({
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        verificationUriComplete: device.verification_uri_complete,
      });
      const payload = await authClient.poll(device, options);
      await rememberTokens(payload);
      return payload;
    },

    async signOut(): Promise<void> {
      await secureStore.set('auth0RefreshToken', null);
      accessToken = null;
      accessTokenExpiresAt = 0;
    },
  });
}
