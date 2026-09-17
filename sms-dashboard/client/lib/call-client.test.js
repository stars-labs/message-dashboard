import { describe, expect, test } from 'bun:test';
import {
  callElapsedSeconds,
  callOutcomeLabel,
  callSim,
  callStateLabel,
  callTone,
  canAnswer,
  canDial,
  canHangup,
  countMissedSince,
  describeCallError,
  formatCallTime,
  formatDuration,
  isMissedCall,
  isValidE164,
  matchesPhoneQuery,
  normaliseNumber,
} from './call-client.js';

describe('number handling', () => {
  test('accepts E.164 and rejects local or malformed numbers', () => {
    expect(isValidE164('+6597817169')).toBe(true);
    expect(isValidE164('+8613520607015')).toBe(true);
    expect(isValidE164('97817169')).toBe(false);
    expect(isValidE164('+0597817169')).toBe(false);
    expect(isValidE164('10086')).toBe(false);
    expect(isValidE164(undefined)).toBe(false);
  });

  test('normalises the separators people actually type', () => {
    expect(normaliseNumber(' +65 9781-7169 ')).toBe('+6597817169');
    expect(normaliseNumber('(+86) 135 2060 7015')).toBe('8613520607015');
    expect(normaliseNumber('+86 (135) 2060-7015')).toBe('+8613520607015');
    expect(normaliseNumber(null)).toBe('');
  });
});

describe('call panel rules', () => {
  const ringing = { direction: 'inbound', state: 'ringing' };
  const dialing = { direction: 'outbound', state: 'connecting' };

  test('dialing needs a clear line because only one call may exist', () => {
    expect(canDial(null)).toBe(true);
    expect(canDial(ringing)).toBe(false);
    expect(canDial(dialing)).toBe(false);
  });

  test('only a ringing inbound call can be answered', () => {
    expect(canAnswer(ringing)).toBe(true);
    expect(canAnswer(dialing)).toBe(false);
    expect(canAnswer({ direction: 'inbound', state: 'active' })).toBe(false);
    expect(canAnswer(null)).toBe(false);
  });

  test('hang-up is available whenever any call exists, to clear stale locks', () => {
    expect(canHangup(ringing)).toBe(true);
    expect(canHangup(dialing)).toBe(true);
    expect(canHangup(null)).toBe(false);
  });

  test('labels each state and falls back to the raw state', () => {
    expect(callStateLabel(null)).toBeNull();
    expect(callStateLabel(ringing)).toBe('来电');
    expect(callStateLabel(dialing)).toBe('正在连接');
    expect(callStateLabel({ state: 'something-new' })).toBe('something-new');
  });
});

describe('call display helpers', () => {
  const phones = [
    { iccid: '8965012306052373985', number: '+6597817169', sim_index: 86, carrier: 'Singtel' },
    { iccid: '8965030124051507919', number: '+6590421798', sim_index: 77, carrier: 'M1' },
  ];

  test('formatDuration switches to hours only once a call runs that long', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(-5)).toBe('00:00');
  });

  test('elapsed time counts from the answer for an inbound call', () => {
    const now = Date.parse('2026-09-17T10:00:30Z');
    const call = { started_at: '2026-09-17T10:00:00Z', answered_at: '2026-09-17T10:00:20Z' };
    expect(callElapsedSeconds(call, now)).toBe(10);
    expect(callElapsedSeconds({ started_at: '2026-09-17T10:00:00Z' }, now)).toBe(30);
    expect(callElapsedSeconds(null, now)).toBe(0);
    expect(callElapsedSeconds({ started_at: 'not a date' }, now)).toBe(0);
  });

  test('callTone separates an inbound ring from a call being set up', () => {
    expect(callTone(null)).toBe('idle');
    expect(callTone({ direction: 'inbound', state: 'ringing' })).toBe('ringing');
    expect(callTone({ direction: 'outbound', state: 'connecting' })).toBe('pending');
    expect(callTone({ direction: 'outbound', state: 'active' })).toBe('active');
  });

  test('callSim resolves the SIM a call is using', () => {
    expect(callSim({ iccid: phones[1].iccid }, phones)).toBe(phones[1]);
    expect(callSim({ iccid: 'unknown' }, phones)).toBeNull();
    expect(callSim(null, phones)).toBeNull();
  });

  test('SIM search matches card number, number, carrier and ICCID', () => {
    expect(matchesPhoneQuery(phones[0], '')).toBe(true);
    expect(matchesPhoneQuery(phones[0], 's86')).toBe(true);
    expect(matchesPhoneQuery(phones[0], 'singtel')).toBe(true);
    expect(matchesPhoneQuery(phones[0], '97817')).toBe(true);
    expect(matchesPhoneQuery(phones[0], '89650123')).toBe(true);
    expect(matchesPhoneQuery(phones[0], 'm1')).toBe(false);
  });

  test('errors become something a dispatcher can act on', () => {
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    expect(describeCallError(denied)).toContain('麦克风权限');

    const busy = new Error('NotReadableError');
    busy.name = 'NotReadableError';
    expect(describeCallError(busy)).toContain('被其他程序占用');

    expect(describeCallError(new Error('Another call is already active'))).toContain('另一路通话');
    expect(describeCallError(new Error('Voice calling is not configured: missing TURN_KEY_ID')))
      .toContain('还没配置');
    expect(describeCallError(new Error('No active call'))).toContain('已经结束');
    expect(describeCallError(new Error('音频连接超时'))).toBe('音频连接超时');
    expect(describeCallError(null)).toBeNull();
  });
});

describe('call log helpers', () => {
  const missed = { direction: 'inbound', outcome: 'missed', started_at: '2026-09-17T10:00:00Z' };

  test('outcomes read as plain Chinese', () => {
    expect(callOutcomeLabel({ outcome: 'answered' })).toBe('已接通');
    expect(callOutcomeLabel({ outcome: 'missed' })).toBe('未接');
    expect(callOutcomeLabel({ outcome: 'cancelled' })).toBe('已取消');
    expect(callOutcomeLabel({})).toBe('');
  });

  test('only unanswered inbound calls count as missed', () => {
    expect(isMissedCall(missed)).toBe(true);
    expect(isMissedCall({ direction: 'outbound', outcome: 'missed' })).toBe(false);
    expect(isMissedCall({ direction: 'inbound', outcome: 'answered' })).toBe(false);
  });

  test('the badge counts only misses since the panel was last opened', () => {
    const entries = [
      missed,
      { ...missed, started_at: '2026-09-17T09:00:00Z' },
      { direction: 'inbound', outcome: 'answered', started_at: '2026-09-17T11:00:00Z' },
    ];
    expect(countMissedSince(entries, '2026-09-17T09:30:00Z')).toBe(1);
    expect(countMissedSince(entries, null)).toBe(2);
    expect(countMissedSince([], '2026-09-17T09:30:00Z')).toBe(0);
  });

  test('log timestamps drop the date only for today', () => {
    // Beijing, like every other absolute time in the app.
    const now = Date.parse('2026-09-17T04:00:00.000Z');
    expect(formatCallTime('2026-09-17T01:05:00.000Z', now)).toBe('09:05');
    expect(formatCallTime('2026-09-15T14:30:00.000Z', now)).toBe('09/15 22:30');
    expect(formatCallTime(null, now)).toBe('');
  });
});
