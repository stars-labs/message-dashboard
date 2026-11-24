// Every history write is swallowed on failure: logging must never stop a call being
// placed, answered, or hung up, because hangup releases the fleet lock.

import {
  closeStaleCalls,
  findOpenRing,
  insertCall,
  insertInboundRing,
  listSimsByIccid,
  markCallAnswered,
  markCallEnded,
  setRemoteNumber,
  type OpenRingRow,
  type SimRow,
} from '../db/calls.js';
import { D1_MAX_BOUND_PARAMETERS, type D1 } from '../lib/d1.js';
import type { CallHistoryRow, Direction, LiveCall } from '../../shared/api/calls.js';
import { present } from './call-media.js';

/** A row still open after this lost its end report. */
const STALE_CALL_MS = 2 * 60 * 60 * 1000;
const STALE_RING_MS = 5 * 60 * 1000;

async function history(db: D1<'run'>, write: (db: D1<'run'>) => Promise<unknown>): Promise<void> {
  try {
    await write(db);
  } catch (error) {
    console.error('call history write failed', error);
  }
}

/** An unanswered ring is swept sooner: while open it holds this SIM's open-ring slot. */
function sweepStaleCalls(db: D1<'run'>, now: string): Promise<unknown> {
  return closeStaleCalls(db, {
    now,
    startedBefore: new Date(Date.now() - STALE_CALL_MS).toISOString(),
    ringStartedBefore: new Date(Date.now() - STALE_RING_MS).toISOString(),
  });
}

/**
 * Concurrent RING and caller-ID reports can both reach D1 before either claims
 * the live state. The partial unique index keeps one open row per SIM, so both
 * reports use the same ID.
 */
export async function claimRing(
  db: D1<'first' | 'run'>,
  iccid: string,
  from: string | null,
): Promise<OpenRingRow | null> {
  try {
    const now = new Date().toISOString();
    await sweepStaleCalls(db, now);
    await insertInboundRing(db, { id: crypto.randomUUID(), iccid, from, now });

    return await findOpenRing(db, iccid);
  } catch (error) {
    console.error('call history ring claim failed', error);
    return null;
  }
}

export function logCallStarted(db: D1<'run'>, call: LiveCall): Promise<void> {
  return history(db, async (log) => {
    await sweepStaleCalls(log, new Date().toISOString());
    await insertCall(log, call);
  });
}

export function logCallerId(db: D1<'run'>, callId: string, number: string): Promise<void> {
  return history(db, (log) => setRemoteNumber(log, callId, number));
}

export function logCallAnswered(
  db: D1<'run'>,
  callId: string,
  { at, by = null }: { at: string; by?: string | null },
): Promise<void> {
  return history(db, (log) => markCallAnswered(log, callId, at, by));
}

type EndedBy = 'dashboard' | 'daemon' | 'worker';

/** `dashboard` is the operator, `daemon` the Pi, `worker` a setup failure here. */
export function unansweredOutcome(
  direction: Direction,
  endedBy: EndedBy,
  reason: string,
): 'failed' | 'rejected' | 'cancelled' | 'missed' {
  if (endedBy === 'worker' || reason === 'setup_failed' || reason === 'adapter_missing') {
    return 'failed';
  }
  if (endedBy === 'dashboard') return direction === 'inbound' ? 'rejected' : 'cancelled';
  return 'missed';
}

/**
 * Idempotent through the `in_progress` guard: the dashboard and the daemon both
 * report the end of the same call, and whoever arrives first decides.
 */
export function logCallEnded(
  db: D1<'run'>,
  call: LiveCall,
  { reason, endedBy }: { reason: string; endedBy: EndedBy },
): Promise<void> {
  return history(db, (log) => {
    const endedAt = new Date().toISOString();
    return markCallEnded(log, {
      callId: call.id,
      endedAt,
      reason,
      unansweredOutcome: unansweredOutcome(call.direction, endedBy, reason),
    });
  });
}

export async function enrichCallPage(db: D1<'all'>, calls: CallHistoryRow[]) {
  const iccids = [...new Set(calls.map((call) => call.iccid).filter(present))];
  const sims = new Map<string, SimRow>();

  for (let start = 0; start < iccids.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = iccids.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const rows = await listSimsByIccid(db, chunk);
    for (const sim of rows) sims.set(sim.iccid, sim);
  }

  return calls.map((call) => {
    const sim = sims.get(call.iccid);
    return {
      ...call,
      sim_index: sim?.sim_index ?? null,
      sim_number: sim?.number ?? null,
      sim_carrier: sim?.carrier ?? null,
    };
  });
}
