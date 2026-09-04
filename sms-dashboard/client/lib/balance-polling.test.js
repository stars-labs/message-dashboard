import { describe, expect, test } from 'bun:test';
import { activeBalanceCheckIds, balancePollDelay } from './balance-polling.js';

describe('active balance query polling', () => {
  test('polls only non-terminal checks', () => {
    expect(activeBalanceCheckIds([
      { id: 'queued', status: 'queued' },
      { id: 'otp', status: 'queued', display_status: 'web_otp' },
      { id: 'done', status: 'parsed' },
      { id: 'failed', status: 'failed' },
    ])).toEqual(['queued', 'otp']);
  });

  test('uses fast polling for fifteen seconds then settles at five seconds', () => {
    expect(balancePollDelay(14_999, 15_000)).toBe(2_000);
    expect(balancePollDelay(15_000, 15_000)).toBe(5_000);
  });
});
