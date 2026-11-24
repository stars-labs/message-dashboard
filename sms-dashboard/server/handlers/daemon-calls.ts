import { ORPCError } from '@orpc/server';
import type * as v from 'valibot';
import {
  type EndedCallBody,
  type EndedCallResponse,
  type IncomingCallBody,
  type IncomingCallResponse,
  type LiveCall,
} from '../../shared/api/calls.js';
import { claimRing, logCallEnded, logCallerId, logCallStarted } from './call-history.js';
import { beginEnding, clearCall, readCall, writeCall, type CallEnv } from './call-live.js';
import { closeAdapters, present } from './call-media.js';

/** The daemon refreshes a ring on every RING; the TTL only covers a lost end report. */
const RING_TTL_SECONDS = 60;

interface DaemonCall {
  env: CallEnv;
}

export const daemonCallsHandler = {
  async incoming(
    { env }: DaemonCall,
    body: v.InferOutput<typeof IncomingCallBody>,
  ): Promise<IncomingCallResponse> {
    const { iccid } = body;
    const from = present(body.from) ? body.from : null;

    let existing = await readCall(env);
    const open = existing ? null : await claimRing(env.DB, iccid, from);
    for (;;) {
      if (existing && (existing.state !== 'ringing' || existing.iccid !== iccid)) {
        // The daemon reads this 409 body.
        throw new ORPCError('CONFLICT', {
          data: { wire: { ok: false, reason: 'another call is active' } },
        });
      }
      const knownNumber = [existing?.number, open?.remote_number].find(present) ?? null;
      const call: LiveCall = {
        id: existing?.id ?? open?.id ?? crypto.randomUUID(),
        direction: 'inbound',
        state: 'ringing',
        iccid,
        number: from ?? knownNumber,
        started_at: existing?.started_at ?? open?.started_at ?? new Date().toISOString(),
      };
      if (await writeCall(env, call, RING_TTL_SECONDS, existing)) {
        if (!existing && !open) {
          await logCallStarted(env.DB, call);
        } else if (from !== null && !present(existing?.number ?? open?.remote_number)) {
          await logCallerId(env.DB, call.id, from);
        }
        return { ok: true, call };
      }
      existing = await readCall(env);
      // An ended ring should not be revived by a refresh that was already in flight.
      if (!existing) return { ok: true, ignored: true };
    }
  },

  async ended(
    { env }: DaemonCall,
    { call_id: callId, iccid, reason }: v.InferOutput<typeof EndedCallBody>,
  ): Promise<EndedCallResponse> {
    const call = await beginEnding(env, (current) =>
      present(callId)
        ? current.id === callId
        : current.iccid === iccid && current.state === 'ringing',
    );
    if (!call) return { ok: true, ignored: true };

    await closeAdapters(env, call);
    await clearCall(env, call);
    await logCallEnded(env.DB, call, {
      reason: present(reason) ? reason.slice(0, 40) : 'ended',
      endedBy: 'daemon',
    });
    return { ok: true, call_id: call.id };
  },
};
