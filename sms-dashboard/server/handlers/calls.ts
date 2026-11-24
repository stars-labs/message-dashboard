// Media flow (docs/voice-calls.md, "Realtime SFU quirks"):
//   1. dial / answer: create the browser session and publish its mic as `mic`.
//   2. connect: create the `down` adapter (SFU streams `mic` to the Pi) and the
//      `up` adapter (the Pi feeds modem audio in as `modem`), then pull `modem`
//      into the browser session. Creating the adapters is what makes the daemon
//      dial or answer, because their signed endpoint URLs carry the command.
//   3. renegotiate: apply the browser's answer to the pull offer.

import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { listCallHistory } from '../db/calls.js';
import {
  IceServersResponse,
  PhoneNumber,
  type AnswerBody,
  type CallHistoryQuery,
  type CallIdBody,
  type CallConnectResponse,
  type CallHangupResponse,
  type CallHistoryResponse,
  type CallMediaResponse,
  type CallRenegotiateResponse,
  type CallStateResponse,
  type DialBody,
  type LiveCall,
  type RenegotiateBody,
} from '../../shared/api/calls.js';
import { enrichCallPage, logCallAnswered, logCallEnded, logCallStarted } from './call-history.js';
import {
  CALL_TTL_SECONDS,
  beginEnding,
  callChanged,
  clearCall,
  conflict,
  readCall,
  writeCall,
  type CallEnv,
} from './call-live.js';
import {
  TRACK_MIC,
  TRACK_MODEM,
  adapterEndpoint,
  callConfig,
  closeAdapters,
  isDescription,
  present,
  publishMic,
  sfu,
  sfuError,
} from './call-media.js';

const ENDPOINT_TTL_SECONDS = CALL_TTL_SECONDS;

const TURN_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export function validNumber(value: unknown): boolean {
  return v.is(PhoneNumber, value);
}

async function failMedia(
  env: CallEnv,
  call: LiveCall,
  error: ORPCError<string, unknown>,
): Promise<never> {
  await closeAdapters(env, call);
  if (await clearCall(env, call)) {
    await logCallEnded(env.DB, call, { reason: 'sfu_error', endedBy: 'worker' });
  }
  throw error;
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

interface BrowserCall {
  env: CallEnv;
  user?: { id: string } | undefined;
}

export const callsHandler = {
  async state({ env }: BrowserCall): Promise<CallStateResponse> {
    return { call: await readCall(env) };
  },

  /** Never on the polling path, so it cannot eat the D1 row-read quota. */
  async history(
    { env }: BrowserCall,
    query: v.InferOutput<typeof CallHistoryQuery>,
  ): Promise<CallHistoryResponse> {
    const { DB } = env;
    const limit = boundedInt(query.limit ?? null, 30, 1, 100);
    const offset = boundedInt(query.offset ?? null, 0, 0, Number.MAX_SAFE_INTEGER);
    const iccid = query.iccid;

    // One row past the page decides `has_more` without a second COUNT query.
    const rows = await listCallHistory(DB, { iccid, limit: limit + 1, offset });

    const page = rows.slice(0, limit);
    return { calls: await enrichCallPage(DB, page), has_more: rows.length > limit };
  },

  /** The TURN token stays in the Worker; the browser only sees a 10-minute credential. */
  async ice({ env }: BrowserCall): Promise<IceServersResponse> {
    const config = callConfig(env);
    const response = await fetch(
      `${TURN_BASE}/${config.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 600 }),
      },
    );
    const text = await response.text();
    const iceServers = parseJson(text, IceServersResponse);
    if (!response.ok || !iceServers.ok) {
      console.error('[calls] Could not issue ICE servers:', text);
      throw new ORPCError('BAD_GATEWAY', { message: `Could not issue ICE servers: ${text}` });
    }
    return iceServers.value;
  },

  async dial(
    { env, user }: BrowserCall,
    { iccid, number, offer, mid }: v.InferOutput<typeof DialBody>,
  ): Promise<CallMediaResponse> {
    const config = callConfig(env);

    const existing = await readCall(env);
    if (existing) throw conflict('Another call is already active', existing);

    const call: LiveCall = {
      id: crypto.randomUUID(),
      direction: 'outbound',
      state: 'connecting',
      iccid,
      number,
      started_at: new Date().toISOString(),
      requested_by: user?.id ?? null,
    };
    if (!(await writeCall(env, call))) throw conflict('Another call is already active');
    await logCallStarted(env.DB, call);

    const media = await publishMic(config, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) throw callChanged();
    return { call, answer: media.answer };
  },

  async answer(
    { env, user }: BrowserCall,
    { offer, mid }: v.InferOutput<typeof AnswerBody>,
  ): Promise<CallMediaResponse> {
    const config = callConfig(env);

    const call = await readCall(env);
    if (!call) throw new ORPCError('NOT_FOUND', { message: 'No call to answer' });
    if (call.direction !== 'inbound' || call.state !== 'ringing') {
      throw conflict('Only a ringing inbound call can be answered', call);
    }

    // Take the call out of `ringing` first so a RING report cannot shorten its TTL.
    const answeredAt = new Date().toISOString();
    const answeredBy = user?.id ?? null;
    call.state = 'connecting';
    call.answered_at = answeredAt;
    call.answered_by = answeredBy;
    if (!(await writeCall(env, call))) throw callChanged();
    await logCallAnswered(env.DB, call.id, { at: answeredAt, by: answeredBy });

    const media = await publishMic(config, offer, mid);
    if ('error' in media) return failMedia(env, call, media.error);
    call.session_id = media.sessionId;
    if (!(await writeCall(env, call))) throw callChanged();
    return { call, answer: media.answer };
  },

  async connect(
    { env }: BrowserCall,
    { call_id: callId }: v.InferOutput<typeof CallIdBody>,
  ): Promise<CallConnectResponse> {
    const config = callConfig(env);
    const call = await readCall(env);
    if (!call || (callId !== undefined && callId !== call.id)) {
      throw new ORPCError('NOT_FOUND', { message: 'No active call' });
    }
    const sessionId = call.session_id;
    if (call.state !== 'connecting' || !present(sessionId) || call.bridge_started) {
      throw conflict('Call is not ready to connect', call);
    }
    call.bridge_started = true;
    if (!(await writeCall(env, call))) throw callChanged();

    const action = call.direction === 'outbound' ? 'dial' : 'answer';
    const exp = Math.floor(Date.now() / 1000) + ENDPOINT_TTL_SECONDS;
    const endpointFor = (leg: 'up' | 'down') =>
      adapterEndpoint(config, {
        callId: call.id,
        leg,
        action,
        iccid: call.iccid,
        number: call.number,
        exp,
      });

    // Browser mic -> Pi. Its response carries no sessionId: it reads an existing track.
    const down = await sfu(config, 'POST', '/adapters/websocket/new', {
      tracks: [
        {
          location: 'remote',
          sessionId,
          trackName: TRACK_MIC,
          endpoint: await endpointFor('down'),
          outputCodec: 'pcm',
          mode: 'stream',
        },
      ],
    });
    const downId = down.body.tracks?.[0]?.adapterId;
    if (present(downId)) call.adapters = { down: downId };
    if (!down.ok || !present(downId)) {
      return failMedia(env, call, sfuError('Could not create the outgoing audio adapter', down));
    }
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      throw callChanged();
    }

    // Pi modem audio -> SFU, published as a new track in the adapter's own session.
    const up = await sfu(config, 'POST', '/adapters/websocket/new', {
      tracks: [
        {
          location: 'local',
          trackName: TRACK_MODEM,
          endpoint: await endpointFor('up'),
          inputCodec: 'pcm',
          mode: 'buffer',
        },
      ],
    });
    const upTrack = up.body.tracks?.[0];
    const upId = upTrack?.adapterId;
    const modemSessionId = upTrack?.sessionId;
    if (present(upId)) call.adapters = { ...call.adapters, up: upId };
    if (!up.ok || !present(upId) || !present(modemSessionId)) {
      return failMedia(env, call, sfuError('Could not create the incoming audio adapter', up));
    }
    call.modem_session_id = modemSessionId;
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      throw callChanged();
    }

    const pull = await sfu(config, 'POST', `/sessions/${sessionId}/tracks/new`, {
      tracks: [{ location: 'remote', sessionId: modemSessionId, trackName: TRACK_MODEM }],
    });
    const renegotiate = pull.body.requiresImmediateRenegotiation === true;
    const offer = renegotiate ? pull.body.sessionDescription : undefined;
    if (!pull.ok || (renegotiate && !isDescription(offer, 'offer'))) {
      return failMedia(env, call, sfuError('Could not subscribe to the call audio', pull));
    }

    delete call.bridge_started;
    call.state = renegotiate ? 'bridging' : 'active';
    if (!(await writeCall(env, call))) {
      await closeAdapters(env, call);
      throw callChanged();
    }
    if (!renegotiate) {
      // Audio is up: the answer moment for an outbound call. An inbound call
      // recorded it when the operator pressed answer, and COALESCE keeps that.
      await logCallAnswered(env.DB, call.id, { at: new Date().toISOString() });
    }
    return { call, offer: offer ?? null };
  },

  async renegotiate(
    { env }: BrowserCall,
    { answer, call_id: callId }: v.InferOutput<typeof RenegotiateBody>,
  ): Promise<CallRenegotiateResponse> {
    const config = callConfig(env);

    const call = await readCall(env);
    if (!call || (callId !== undefined && callId !== call.id)) {
      throw new ORPCError('NOT_FOUND', { message: 'No active call' });
    }
    const sessionId = call.session_id;
    if (call.state !== 'bridging' || !present(sessionId)) {
      throw conflict('Call is not waiting for renegotiation', call);
    }

    const result = await sfu(config, 'PUT', `/sessions/${sessionId}/renegotiate`, {
      sessionDescription: answer,
    });
    if (!result.ok) {
      return failMedia(env, call, sfuError('Could not renegotiate the session', result));
    }

    call.state = 'active';
    if (!(await writeCall(env, call))) throw callChanged();
    await logCallAnswered(env.DB, call.id, { at: new Date().toISOString() });
    return { call };
  },

  async hangup(
    { env }: BrowserCall,
    { call_id: callId }: v.InferOutput<typeof CallIdBody>,
  ): Promise<CallHangupResponse> {
    const call = await beginEnding(env, (current) => callId === undefined || current.id === callId);
    if (!call) return { call: null, already_clear: true };
    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env.DB, call, { reason: 'hangup', endedBy: 'dashboard' });

    call.state = 'ended';
    call.ended_at = new Date().toISOString();
    return { call };
  },
};
