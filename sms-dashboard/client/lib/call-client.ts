import * as v from 'valibot';
import {
  AnswerBody,
  DialBody,
  RenegotiateBody,
  type CallLogEntry,
  type ENDED_OUTCOMES,
  type IceServersResponse,
  type LiveCall,
} from '../../shared/api/calls.js';
import { contractApi } from './api.js';
import { formatCardNumber } from '../../shared/card-number.js';
import { intervalMs } from '../../shared/recurring.js';
import { toError } from './error-origin.js';
import { formatClock, toEpochMilliseconds } from './time.js';

interface CallPhone {
  iccid: string;
  number?: string | null;
  carrier?: string | null;
  sim_index?: number | null;
}

type IceServer = IceServersResponse['iceServers'][number];

type CallStage = Pick<LiveCall, 'direction' | 'state'>;

type MissedCallFields = Pick<CallLogEntry, 'direction' | 'outcome'>;

type CallTone = 'idle' | 'ringing' | 'pending' | 'active';

export async function fetchCallState(): Promise<LiveCall | null> {
  return (await contractApi.calls.state()).call;
}

// Mirrors the Worker's rule in server/handlers/calls.ts.
export function isValidE164(value: unknown): boolean {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value.trim());
}

export function normaliseNumber(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^\d]/g, '');
}

export function callSim(
  call: Pick<LiveCall, 'iccid'> | null | undefined,
  phones: CallPhone[] | null | undefined,
): CallPhone | null {
  if (!call?.iccid || !Array.isArray(phones)) return null;
  return phones.find((phone) => phone.iccid === call.iccid) ?? null;
}

// Inbound counts from the answer, so the timer shows talk time, not ring time.
export function callElapsedSeconds(
  call: Partial<Pick<LiveCall, 'answered_at' | 'started_at'>> | null | undefined,
  nowMs: number = Date.now(),
): number {
  const since = call?.answered_at ?? call?.started_at;
  if (!since) return 0;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}

export function formatDuration(seconds: number | null | undefined): string {
  const known = seconds === null || seconds === undefined || Number.isNaN(seconds) ? 0 : seconds;
  const total = Math.max(0, Math.floor(known));
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours
    ? `${hours}:${pad(minutes)}:${pad(total % 60)}`
    : `${pad(minutes)}:${pad(total % 60)}`;
}

export function callTone(call: CallStage | null | undefined): CallTone {
  if (!call) return 'idle';
  if (call.state === 'ringing') return call.direction === 'inbound' ? 'ringing' : 'pending';
  if (call.state === 'active') return 'active';
  if (call.state === 'ended') return 'idle';
  return 'pending';
}

// Raw errors are English Worker strings or DOMException names; neither belongs in front of a user mid-call.
export function describeCallError(error: unknown): string | null {
  if (!error) return null;
  const name =
    typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  const message =
    typeof error === 'string' ||
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
      ? String(error)
      : toError(error).message;
  if (name === 'NotAllowedError' || /permission denied/i.test(message)) {
    return '浏览器拒绝了麦克风权限。请在地址栏的权限设置里允许麦克风，然后重试。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '找不到可用的麦克风，请检查设备是否插好。';
  }
  if (name === 'NotReadableError') {
    return '麦克风被其他程序占用，请关掉正在录音的应用后重试。';
  }
  if (/already active/i.test(message)) return '另一路通话正在进行，同一时间只能有一路通话。';
  if (/not configured/i.test(message)) return '服务端还没配置好语音通话，请联系管理员。';
  if (/No call to answer|No active call/i.test(message)) return '这通电话已经结束了。';
  if (/Only a ringing inbound call/i.test(message)) return '这通电话已经不在振铃状态。';
  if (/number must be E\.164/i.test(message)) return '号码需要是国际格式，例如 +6591234567';
  if (/连接超时|连接失败|通话已结束/.test(message)) return message;
  if (/Could not (create|publish|subscribe|renegotiate)/i.test(message)) {
    return '媒体服务器没能建立音频通道，请重试。';
  }
  return message;
}

export function matchesPhoneQuery(
  phone: CallPhone | null | undefined,
  query: string | null | undefined,
): boolean {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return true;
  const card = phone?.sim_index == null ? '' : formatCardNumber(phone.sim_index);
  return [card, phone?.number, phone?.carrier, phone?.iccid]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(q));
}

// Each poll costs a KV read for the session and a request to the CALL_STATE Durable
// Object; a flat 3 s would spend 28,800 KV reads a day per tab against the 100,000
// free-tier limit. Rings last 30 s or more, so idle polling can be slow.
export const CALL_POLL_ACTIVE_MS = intervalMs('dashboardLiveCallState');
export const CALL_POLL_IDLE_MS = intervalMs('dashboardCallState');

export function callPollDelay({
  call = null,
  panelOpen = false,
}: { call?: object | null; panelOpen?: boolean } = {}): number {
  return call || panelOpen ? CALL_POLL_ACTIVE_MS : CALL_POLL_IDLE_MS;
}

const STATE_LABELS = {
  ringing: '来电',
  connecting: '正在连接',
  bridging: '正在接通',
  ending: '正在挂断',
  active: '通话中',
  ended: '已结束',
} as const satisfies Record<LiveCall['state'], string>;

export function callStateLabel(call: Pick<LiveCall, 'state'> | null | undefined): string | null {
  if (!call) return null;
  return STATE_LABELS[call.state];
}

export function canDial(call: object | null | undefined): boolean {
  return !call;
}

export function canAnswer(call: CallStage | null | undefined): boolean {
  return call?.direction === 'inbound' && call.state === 'ringing';
}

// Hang-up also clears a stale lock left by a crashed call.
export function canHangup(call: object | null | undefined): boolean {
  return Boolean(call);
}

const OUTCOME_LABELS = {
  answered: '已接通',
  missed: '未接',
  rejected: '已拒接',
  cancelled: '已取消',
  failed: '未接通',
} as const satisfies Record<(typeof ENDED_OUTCOMES)[number], string>;

export function callOutcomeLabel(entry: Pick<CallLogEntry, 'outcome'> | null | undefined): string {
  return entry ? OUTCOME_LABELS[entry.outcome] : '';
}

export function isMissedCall(entry: MissedCallFields | null | undefined): boolean {
  return entry?.direction === 'inbound' && entry.outcome === 'missed';
}

// `seenAt` is the last time the call panel was opened.
export function countMissedSince(
  entries: readonly (MissedCallFields & Pick<CallLogEntry, 'started_at'>)[] | null | undefined,
  seenAt: unknown,
): number {
  const since = toEpochMilliseconds(seenAt) ?? 0;
  return (entries ?? []).filter((entry) => {
    if (!isMissedCall(entry)) return false;
    const started = toEpochMilliseconds(entry.started_at);
    return started !== null && started > since;
  }).length;
}

export function formatCallTime(value: unknown, now: number = Date.now()): string {
  return formatClock(value, now);
}

export async function fetchIceServers(): Promise<IceServer[]> {
  return (await contractApi.calls.ice()).iceServers;
}

// Read from D1, not the KV call lock, so it includes calls that already ended.
export async function fetchCallHistory({
  limit = 30,
  offset = 0,
  iccid = null,
}: { limit?: number; offset?: number; iccid?: string | null } = {}): Promise<{
  calls: CallLogEntry[];
  hasMore: boolean;
}> {
  const page = await contractApi.calls.history({
    query: { limit: String(limit), offset: String(offset), ...(iccid ? { iccid } : {}) },
  });
  return { calls: page.calls, hasMore: page.has_more };
}

interface MediaOffer {
  offer: unknown;
  mid: string | null;
}

interface DialParams extends MediaOffer {
  iccid: string;
  number: string;
}

// Descriptions are validated against the Worker's body schemas before sending.
export const callApi = {
  dial: (params: DialParams) => contractApi.calls.dial(v.parse(DialBody, params)),
  answer: (params: MediaOffer) => contractApi.calls.answer(v.parse(AnswerBody, params)),
  connect: (callId: string) => contractApi.calls.connect({ call_id: callId }),
  renegotiate: ({ answer, callId }: { answer: unknown; callId?: string }) =>
    contractApi.calls.renegotiate(v.parse(RenegotiateBody, { answer, call_id: callId })),
  hangup: (callId?: string) => contractApi.calls.hangup({ call_id: callId }),
};
