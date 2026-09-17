// Browser side of voice calling: thin API wrappers plus the pure rules the call
// panel uses to decide what it may show. The rules live here, not in the
// component, so they can be tested without a DOM or a microphone.

import { fetchWithAuth } from './api.js';
import { formatCardNumber } from './card-number.js';
import { formatClock, toEpochMilliseconds } from './time.js';

/**
 * Same rule the Worker enforces in server/api/calls.js. Checking it here first
 * gives an instant message instead of a round trip that is certain to fail.
 */
export function isValidE164(value) {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value.trim());
}

/** Normalise user input: drop spaces, dashes and brackets, keep a leading +. */
export function normaliseNumber(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^\d]/g, '');
}

/**
 * A call's identity for display: the SIM it uses, matched against the phone list
 * the dashboard already loaded. Returns null when the SIM is unknown (a SIM that
 * was removed, or a list that has not loaded yet).
 */
export function callSim(call, phones) {
  if (!call?.iccid || !Array.isArray(phones)) return null;
  return phones.find((phone) => phone.iccid === call.iccid) ?? null;
}

/**
 * Seconds the call has been up. Counts from the answer for an inbound call and
 * from the start for an outbound one, so the timer shows talk time rather than
 * how long the phone rang.
 */
export function callElapsedSeconds(call, nowMs = Date.now()) {
  const since = call?.answered_at ?? call?.started_at;
  if (!since) return 0;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / 1000));
}

/** mm:ss, or h:mm:ss once a call passes an hour. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const pad = (n) => String(n).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${pad(minutes)}:${pad(total % 60)}`;
}

/**
 * Which visual treatment a state gets. Kept here so the panel, the top bar and
 * any future surface cannot drift apart on what "ringing" looks like.
 */
export function callTone(call) {
  if (!call) return 'idle';
  if (call.state === 'ringing') return call.direction === 'inbound' ? 'ringing' : 'pending';
  if (call.state === 'active') return 'active';
  if (call.state === 'ended') return 'idle';
  return 'pending';
}

/**
 * Turn an API or media failure into something a dispatcher can act on. The raw
 * messages are English Worker strings or DOMException names, neither of which
 * belongs in front of a user mid-call.
 */
export function describeCallError(error) {
  if (!error) return null;
  const name = error.name ?? '';
  const message = error.message ?? String(error);
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
  if (/number must be E\.164/i.test(message)) return '号码需要是国际格式，例如 +6591234567。';
  if (/连接超时|连接失败|通话已结束/.test(message)) return message;
  if (/Could not (create|publish|subscribe|renegotiate)/i.test(message)) {
    return '媒体服务器没能建立音频通道，请重试。';
  }
  return message;
}

/** Search a SIM by card number, phone number, carrier or ICCID. */
export function matchesPhoneQuery(phone, query) {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return true;
  const card = phone?.sim_index == null ? '' : formatCardNumber(phone.sim_index);
  return [card, phone?.number, phone?.carrier, phone?.iccid]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(q));
}

/** Rejecting an inbound call is a hang-up, but it deserves its own label. */
export function canReject(call) {
  return canAnswer(call);
}

const STATE_LABELS = {
  ringing: '来电',
  connecting: '正在连接',
  bridging: '正在接通',
  active: '通话中',
  ended: '已结束',
};

/** Human label for a call, or null when there is no call. */
export function callStateLabel(call) {
  if (!call) return null;
  return STATE_LABELS[call.state] ?? call.state;
}

/** Only one call may exist across the fleet, so dialing needs a clear line. */
export function canDial(call) {
  return !call;
}

export function canAnswer(call) {
  return Boolean(call && call.direction === 'inbound' && call.state === 'ringing');
}

/**
 * Hang-up must always be available while anything exists: it is also how a user
 * clears a stale lock left by a crashed call.
 */
export function canHangup(call) {
  return Boolean(call);
}

/**
 * How a finished call reads in the log. `in_progress` only appears for a row a
 * crash left behind, so it is labelled rather than hidden.
 */
const OUTCOME_LABELS = {
  answered: '已接通',
  missed: '未接',
  rejected: '已拒接',
  cancelled: '已取消',
  failed: '未接通',
  in_progress: '进行中',
};

export function callOutcomeLabel(entry) {
  return OUTCOME_LABELS[entry?.outcome] ?? entry?.outcome ?? '';
}

/** A call the operator should follow up on: it rang here and nobody answered. */
export function isMissedCall(entry) {
  return entry?.direction === 'inbound' && entry?.outcome === 'missed';
}

/**
 * Missed calls the operator has not looked at yet, for the badge on the call
 * button. `seenAt` is the last time the call panel was opened.
 */
export function countMissedSince(entries, seenAt) {
  const since = toEpochMilliseconds(seenAt) ?? 0;
  return (entries ?? []).filter((entry) => {
    if (!isMissedCall(entry)) return false;
    const started = toEpochMilliseconds(entry.started_at);
    return started !== null && started > since;
  }).length;
}

/** Clock time for a log row. Shared with every other absolute time in the app. */
export function formatCallTime(value, now = Date.now()) {
  return formatClock(value, now);
}

function post(path, body) {
  return fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

export async function fetchCallState() {
  const { call } = await fetchWithAuth('/api/calls/state');
  return call ?? null;
}

export async function fetchIceServers() {
  const { iceServers } = await fetchWithAuth('/api/calls/ice');
  return iceServers ?? [];
}

/**
 * Call log, newest first. Read straight from D1 rather than the KV call lock,
 * so it is unaffected by the lock's TTL and shows calls that already ended.
 */
export async function fetchCallHistory({ limit = 30, offset = 0, iccid = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (iccid) params.set('iccid', iccid);
  const { calls, has_more: hasMore } = await fetchWithAuth(`/api/calls/history?${params}`);
  return { calls: calls ?? [], hasMore: Boolean(hasMore) };
}

/** The API surface call-session.js drives; each returns the Worker's JSON. */
export const callApi = {
  dial: ({ iccid, number, offer, mid }) => post('/api/calls/dial', { iccid, number, offer, mid }),
  answer: ({ offer, mid }) => post('/api/calls/answer', { offer, mid }),
  connect: () => post('/api/calls/connect'),
  renegotiate: ({ answer }) => post('/api/calls/renegotiate', { answer }),
  hangup: () => post('/api/calls/hangup'),
};
