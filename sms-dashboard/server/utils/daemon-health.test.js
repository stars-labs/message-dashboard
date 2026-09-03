import { describe, expect, test } from 'bun:test';
import { deriveDaemonHealth, normalizeHealthSnapshot } from './daemon-health.js';

function snapshot(overrides = {}) {
  return normalizeHealthSnapshot({
    schema_version: 3, session_id: 'rust-daemon-test', version: '8.0.0', uptime_seconds: 600,
    last_message_read_success_age_seconds: 2, last_upload_success_age_seconds: 8,
    queue: { pending: 0, in_flight: 0, dead_letter: 0, oldest_unacknowledged_age_seconds: null },
    ...overrides,
  });
}

describe('daemon health v3', () => {
  test('rejects legacy snapshots instead of retaining a dual contract', () => {
    expect(() => normalizeHealthSnapshot({ schema_version: 2 })).toThrow();
  });
  test('keeps an idle uploader healthy', () => {
    const value = snapshot({ last_upload_success_age_seconds: 999 });
    expect(deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) }).status).toBe('healthy');
  });
  test('degrades an old unacknowledged queue and dead letters', () => {
    const value = snapshot({ queue: { pending: 2, in_flight: 1, dead_letter: 1, oldest_unacknowledged_age_seconds: 301 } });
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) });
    expect(result.status).toBe('degraded');
    expect(result.reasons).toContain('消息积压超过 5 分钟');
    expect(result.reasons).toContain('1 条消息需要人工处理');
  });
});
