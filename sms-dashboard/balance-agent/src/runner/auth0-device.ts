import * as v from 'valibot';
import { readJson } from '../../../shared/parse-json.js';
import { textOr } from '../../../shared/text.js';
import type { FetchImpl } from './control-client.js';

const RUNNER_SCOPES = [
  'openid',
  'offline_access',
  'balance:runners:heartbeat',
  'balance:skills:run',
  'balance:browser:run',
];

const OptionalText = v.fallback(v.optional(v.string()), undefined);

const AuthAnswer = v.object({
  error: OptionalText,
  error_description: OptionalText,
  device_code: OptionalText,
  user_code: OptionalText,
  verification_uri: OptionalText,
  verification_uri_complete: OptionalText,
  interval: v.optional(v.number()),
  expires_in: v.optional(v.number()),
  access_token: OptionalText,
  refresh_token: OptionalText,
});

type AuthAnswer = v.InferOutput<typeof AuthAnswer>;

const NO_ANSWER = v.parse(AuthAnswer, {});

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string | undefined;
  verification_uri_complete: string | undefined;
  interval: number | undefined;
  expires_in: number | undefined;
}

export interface Tokens {
  access_token: string;
  refresh_token: string | undefined;
  expires_in: number | undefined;
}

interface PollableDevice {
  device_code: string;
  interval?: number | undefined;
  expires_in?: number | undefined;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function issuerUrl(issuer: string, path: string): string {
  const base = issuer.trim().replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error('Auth0 issuer must use HTTPS');
  return `${base}${path}`;
}

async function authRequest(
  url: string,
  body: URLSearchParams,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<{ response: Response; payload: AuthAnswer }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    ...(signal ? { signal } : {}),
  });
  const parsed = await readJson(response, AuthAnswer);
  return { response, payload: parsed.ok ? parsed.value : NO_ANSWER };
}

function authError(payload: AuthAnswer, fallback: string): string {
  const code = payload.error?.trim() ?? '';
  const description = payload.error_description?.trim() ?? '';
  if (code && description) return `${code}: ${description}`;
  return description || code || fallback;
}

function tokensOf(payload: AuthAnswer): Tokens | null {
  return payload.access_token
    ? {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        expires_in: payload.expires_in,
      }
    : null;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createAuth0DeviceClient({
  issuer,
  clientId,
  audience,
  fetchImpl = fetch,
  sleep = defaultSleep,
}: {
  issuer: string;
  clientId: string;
  audience: string;
  fetchImpl?: FetchImpl;
  sleep?: Sleep;
}) {
  if (!clientId || !audience) throw new Error('Auth0 client ID and audience are required');

  return Object.freeze({
    async begin({ signal }: { signal?: AbortSignal } = {}): Promise<DeviceAuthorization> {
      const { response, payload } = await authRequest(
        issuerUrl(issuer, '/oauth/device/code'),
        new URLSearchParams({
          client_id: clientId,
          audience,
          scope: RUNNER_SCOPES.join(' '),
        }),
        fetchImpl,
        signal,
      );
      if (!response.ok || !payload.device_code || !payload.user_code) {
        throw new Error(authError(payload, `Could not start device login (${response.status})`));
      }
      return {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload.verification_uri,
        verification_uri_complete: payload.verification_uri_complete,
        interval: payload.interval,
        expires_in: payload.expires_in,
      };
    },

    async poll(
      device: PollableDevice,
      { signal, onPending }: { signal?: AbortSignal; onPending?: () => void } = {},
    ): Promise<Tokens> {
      let interval = Math.max(1, device.interval ?? 5);
      const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
      while (!signal?.aborted && Date.now() < deadline) {
        await sleep(interval * 1000, signal);
        if (signal?.aborted) break;
        const { response, payload } = await authRequest(
          issuerUrl(issuer, '/oauth/token'),
          new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device.device_code,
            client_id: clientId,
          }),
          fetchImpl,
          signal,
        );
        const tokens = tokensOf(payload);
        if (response.ok && tokens) return tokens;
        if (payload.error === 'authorization_pending') {
          onPending?.();
          continue;
        }
        if (payload.error === 'slow_down') {
          interval += 5;
          continue;
        }
        throw new Error(
          textOr(
            payload.error_description,
            textOr(payload.error, `Device login failed (${response.status})`),
          ),
        );
      }
      if (signal?.aborted) throw new Error('Device login cancelled');
      throw new Error('Device login expired');
    },

    async refresh(
      refreshToken: string,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<Tokens> {
      const { response, payload } = await authRequest(
        issuerUrl(issuer, '/oauth/token'),
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshToken,
        }),
        fetchImpl,
        signal,
      );
      const tokens = tokensOf(payload);
      if (!response.ok || !tokens) {
        throw new Error(
          textOr(
            payload.error_description,
            textOr(payload.error, `Token refresh failed (${response.status})`),
          ),
        );
      }
      return tokens;
    },
  });
}

export { RUNNER_SCOPES };
