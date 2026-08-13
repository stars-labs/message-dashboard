import { describe, expect, test } from 'bun:test';
import {
  formatTaskAge,
  getDaemonStatusMeta,
  isDaemonConnected,
  normalizeDaemonStatus,
} from './daemon-status.js';

describe('daemon status compatibility', () => {
  test('maps legacy online and warning states', () => {
    expect(normalizeDaemonStatus('online')).toBe('healthy');
    expect(normalizeDaemonStatus('warning')).toBe('degraded');
  });

  test('only healthy and degraded services count as connected', () => {
    expect(isDaemonConnected('healthy')).toBe(true);
    expect(isDaemonConnected('degraded')).toBe(true);
    expect(isDaemonConnected('offline')).toBe(false);
  });

  test('uses an amber presentation for degraded services', () => {
    expect(getDaemonStatusMeta('degraded').dotClass).toContain('amber');
  });
});

describe('formatTaskAge', () => {
  test('formats task ages without invalid values', () => {
    expect(formatTaskAge(null)).toBe('尚未成功');
    expect(formatTaskAge(undefined)).toBe('尚未成功');
    expect(formatTaskAge(75)).toBe('1分钟前');
  });
});
