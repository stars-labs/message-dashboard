// A Durable Object owns the live call state; D1 holds the call log, written only at
// transitions, so three-second polling never touches D1.

import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { readJson } from '../../shared/parse-json.js';
import type { D1 } from '../lib/d1.js';
import { LiveCall } from '../../shared/api/calls.js';

const CallSnapshot = v.nullable(v.object({ call: LiveCall, revision: v.string() }));

export interface CallEnv {
  CALL_STATE: {
    getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> };
  };
  DB: D1<'all' | 'first' | 'run'>;
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  VOICE_BRIDGE_HOST?: string;
  API_KEY?: string;
}

/** A wedged call expires on its own rather than blocking the fleet. */
export const CALL_TTL_SECONDS = 3600;

const revisions = new WeakMap<LiveCall, string>();
const stateUrl = 'https://call-state/';

export async function readCall(env: CallEnv): Promise<LiveCall | null> {
  const response = await env.CALL_STATE.getByName('fleet').fetch(stateUrl);
  if (!response.ok) throw new Error('Could not read live call state');
  const snapshot = await readJson(response, CallSnapshot);
  if (!snapshot.ok) throw new Error(`Live call state is unreadable: ${snapshot.error}`);
  if (snapshot.value === null) return null;
  revisions.set(snapshot.value.call, snapshot.value.revision);
  return snapshot.value.call;
}

async function changeCall(
  env: CallEnv,
  expected: LiveCall | null,
  call: LiveCall | null,
  ttl: number = CALL_TTL_SECONDS,
): Promise<boolean> {
  const expectedRevision = expected === null ? null : revisions.get(expected);
  // A call this isolate never read has no known revision, so it cannot match.
  if (expectedRevision === undefined) return false;
  const response = await env.CALL_STATE.getByName('fleet').fetch(stateUrl, {
    method: 'POST',
    body: JSON.stringify({ expected: expectedRevision, call, ttl }),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error('Could not change live call state');
  if (call) {
    const revision = await readJson(response, v.string());
    if (!revision.ok) throw new Error(`Live call revision is unreadable: ${revision.error}`);
    revisions.set(call, revision.value);
  }
  return true;
}

export function writeCall(
  env: CallEnv,
  call: LiveCall,
  ttl: number = CALL_TTL_SECONDS,
  expected: LiveCall | null = call,
): Promise<boolean> {
  return changeCall(env, expected !== null && revisions.has(expected) ? expected : null, call, ttl);
}

export function clearCall(env: CallEnv, call: LiveCall): Promise<boolean> {
  return changeCall(env, call, null);
}

export async function beginEnding(
  env: CallEnv,
  matches: (call: LiveCall) => boolean,
): Promise<LiveCall | null> {
  let call = await readCall(env);
  const id = call?.id;
  while (call && call.id === id && call.state !== 'ending' && matches(call)) {
    call.state = 'ending';
    if (await writeCall(env, call)) return call;
    call = await readCall(env);
  }
  return null;
}

export function callChanged(): ORPCError<'CONFLICT', undefined> {
  return new ORPCError('CONFLICT', { message: 'No active call' });
}

export function conflict(
  message: string,
  call?: LiveCall,
): ORPCError<'CONFLICT', { call: LiveCall } | undefined> {
  return new ORPCError('CONFLICT', { message, data: call === undefined ? undefined : { call } });
}
