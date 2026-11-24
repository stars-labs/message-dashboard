import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { SessionDescription, type LiveCall } from '../../shared/api/calls.js';
import type { CallEnv } from './call-live.js';

/** The SFU can report an error inside a 200. */
const SfuBody = v.object({
  sessionId: v.optional(v.string()),
  sessionDescription: v.optional(SessionDescription),
  requiresImmediateRenegotiation: v.optional(v.boolean()),
  tracks: v.optional(
    v.array(
      v.object({
        adapterId: v.optional(v.string()),
        sessionId: v.optional(v.string()),
        errorCode: v.nullish(v.string()),
      }),
    ),
  ),
  errorCode: v.nullish(v.string()),
});

type SfuBody = v.InferOutput<typeof SfuBody>;

interface SfuResult {
  ok: boolean;
  status: number;
  body: SfuBody;
  detail: unknown;
}

const Configured = v.pipe(v.string(), v.minLength(1));

const CallConfig = v.object({
  REALTIME_APP_ID: Configured,
  REALTIME_APP_SECRET: Configured,
  TURN_KEY_ID: Configured,
  TURN_API_TOKEN: Configured,
  VOICE_BRIDGE_HOST: Configured,
  API_KEY: Configured,
});

type CallConfig = v.InferOutput<typeof CallConfig>;

export const TRACK_MIC = 'mic';
export const TRACK_MODEM = 'modem';

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';
const SFU_REQUEST_TIMEOUT_MS = 15_000;

export function missingConfig(env: object): string[] {
  const result = v.safeParse(CallConfig, env);
  if (result.success) return [];
  return result.issues.flatMap((issue) => {
    const key = v.getDotPath(issue);
    return key === null ? [] : [key];
  });
}

export function callConfig(env: CallEnv): CallConfig {
  const result = v.safeParse(CallConfig, env);
  if (result.success) return result.output;
  throw new ORPCError('SERVICE_UNAVAILABLE', {
    message: `Voice calling is not configured: missing ${missingConfig(env).join(', ')}`,
  });
}

export function present(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== '';
}

export function isDescription(
  value: SessionDescription | undefined,
  type: SessionDescription['type'],
): value is SessionDescription {
  return value?.type === type && value.sdp !== '';
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signed adapter endpoint the daemon verifies before it touches a modem.
 *
 * Path: /voice/{callId}/{leg}/{action}/{iccid}/{number}/{exp}/{sig}
 * sig = hex HMAC-SHA256(API_KEY, "callId\nleg\naction\niccid\nnumber\nexp").
 * The same test vector lives in the daemon's tests; change both together.
 */
export async function adapterEndpoint(
  config: Pick<CallConfig, 'API_KEY' | 'VOICE_BRIDGE_HOST'>,
  {
    callId,
    leg,
    action,
    iccid,
    number,
    exp,
  }: {
    callId: string;
    leg: 'up' | 'down';
    action: 'dial' | 'answer';
    iccid: string;
    number: string | null;
    exp: number;
  },
): Promise<string> {
  const numberSegment = action === 'answer' ? '-' : (number ?? '');
  const message = [callId, leg, action, iccid, numberSegment, String(exp)].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.API_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  const segments = [callId, leg, action, iccid, numberSegment, String(exp), sig].map(
    encodeURIComponent,
  );
  return `wss://${config.VOICE_BRIDGE_HOST}/voice/${segments.join('/')}`;
}

/** `body === undefined` sends no body at all, which sessions/new requires. */
export async function sfu(
  config: Pick<CallConfig, 'REALTIME_APP_ID' | 'REALTIME_APP_SECRET'>,
  method: string,
  path: string,
  body?: unknown,
): Promise<SfuResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.REALTIME_APP_SECRET}`,
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(SFU_REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  let text;
  try {
    response = await fetch(`${SFU_BASE}/apps/${config.REALTIME_APP_ID}${path}`, init);
    text = await response.text();
  } catch {
    return { ok: false, status: 502, body: {}, detail: { error: 'SFU connection failed' } };
  }
  const raw = parseJson(text, v.unknown());
  const parsed = raw.ok ? v.safeParse(SfuBody, raw.value) : null;
  if (!raw.ok || !parsed?.success) {
    return {
      ok: false,
      status: response.status,
      body: {},
      detail: { error: 'Invalid SFU response', raw: text },
    };
  }
  const reply = parsed.output;
  const trackError = reply.tracks?.some((track) => present(track.errorCode)) ?? false;
  const ok = response.ok && !present(reply.errorCode) && !trackError;
  return { ok, status: response.status, body: reply, detail: raw.value };
}

export function sfuError(message: string, result: SfuResult): ORPCError<'BAD_GATEWAY', undefined> {
  const detail = typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail);
  console.error(`[calls] ${message}:`, detail);
  return new ORPCError('BAD_GATEWAY', { message: `${message}: ${detail}` });
}

export async function publishMic(
  config: CallConfig,
  offer: { type: 'offer'; sdp: string },
  mid: string,
): Promise<
  { sessionId: string; answer: SessionDescription } | { error: ORPCError<'BAD_GATEWAY', undefined> }
> {
  const session = await sfu(config, 'POST', '/sessions/new');
  const sessionId = session.body.sessionId;
  if (!session.ok || !present(sessionId)) {
    return { error: sfuError('Could not create an SFU session', session) };
  }

  const tracks = await sfu(config, 'POST', `/sessions/${sessionId}/tracks/new`, {
    sessionDescription: offer,
    tracks: [{ location: 'local', mid, trackName: TRACK_MIC }],
  });
  const answer = tracks.body.sessionDescription;
  if (!tracks.ok || !isDescription(answer, 'answer')) {
    return { error: sfuError('Could not publish the microphone', tracks) };
  }
  return { sessionId, answer };
}

/** Best effort: the daemon also hangs up when its WebSocket drops or the call TTL ends. */
export async function closeAdapters(env: CallEnv, call: LiveCall): Promise<void> {
  const ids = [call.adapters?.up, call.adapters?.down].filter(present);
  const config = v.safeParse(CallConfig, env);
  if (ids.length === 0 || !config.success) return;
  await sfu(config.output, 'POST', '/adapters/websocket/close', {
    tracks: ids.map((adapterId) => ({ adapterId })),
  });
}
