import { describe, expect, test } from 'bun:test';
import { deriveDaemonHealth, normalizeHealthSnapshot } from './daemon-health.js';

function snapshot(overrides: Record<string, unknown> = {}) {
  return normalizeHealthSnapshot({
    schema_version: 3,
    session_id: 'rust-daemon-test',
    version: '8.0.0',
    uptime_seconds: 600,
    last_message_read_success_age_seconds: 2,
    last_upload_success_age_seconds: 8,
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
    expect(
      deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) }).status,
    ).toBe('healthy');
  });
  test('degrades an old unacknowledged queue and dead letters', () => {
    const value = snapshot({
      queue: { pending: 2, in_flight: 1, dead_letter: 1, oldest_unacknowledged_age_seconds: 301 },
    });
    const result = deriveDaemonHealth({
      seconds_since_heartbeat: 2,
      metadata: JSON.stringify(value),
    });
    expect(result.status).toBe('degraded');
    expect(result.reasons).toContain('消息积压超过 5 分钟');
    expect(result.reasons).toContain('1 条消息需要人工处理');
  });
  test('treats stored metadata that lacks the snapshot fields as an invalid report', () => {
    for (const metadata of [
      JSON.stringify({ schema_version: 3 }),
      JSON.stringify({ ...snapshot(), queue: undefined }),
      JSON.stringify({ ...snapshot(), uptime_seconds: 'long' }),
      { schema_version: 3, session_id: 'rust-daemon-test' },
    ]) {
      const result = deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata });
      expect(result.status).toBe('unknown');
      expect(result.reasons).toEqual(['健康报告格式无效或缺失']);
      expect(result.snapshot).toBeNull();
    }
  });
  test('rejects uploads that are not objects with the supported schema version', () => {
    for (const raw of [null, undefined, 'text', 3, [], { schema_version: '3' }]) {
      expect(() => normalizeHealthSnapshot(raw)).toThrow('Unsupported health schema version');
    }
    expect(() => normalizeHealthSnapshot(null)).toThrow('missing');
    expect(() => normalizeHealthSnapshot({ schema_version: 2 })).toThrow('version: 2');
  });
  test('requires a session id and a version', () => {
    expect(() => snapshot({ session_id: '  ' })).toThrow('session_id and version are required');
    expect(() => snapshot({ version: 8 })).toThrow('session_id and version are required');
  });
  test('coerces numeric strings, defaults counters and drops invalid ages', () => {
    const value = snapshot({
      uptime_seconds: '12',
      last_message_read_success_age_seconds: -1,
      last_upload_success_age_seconds: 'soon',
      queue: 'broken',
    });
    expect(value.uptime_seconds).toBe(12);
    expect(value.last_message_read_success_age_seconds).toBeNull();
    expect(value.last_upload_success_age_seconds).toBeNull();
    expect(value.queue).toEqual({
      pending: 0,
      in_flight: 0,
      dead_letter: 0,
      oldest_unacknowledged_age_seconds: null,
    });
  });
  test('trims and truncates the session id and version', () => {
    const value = snapshot({ session_id: ` ${'s'.repeat(200)} `, version: ' 1.2.3 ' });
    expect(value.session_id).toHaveLength(120);
    expect(value.version).toBe('1.2.3');
  });
  test('has no health report for a missing row and is offline after three minutes', () => {
    expect(deriveDaemonHealth(null).status).toBe('unknown');
    const metadata = JSON.stringify(snapshot());
    const offline = deriveDaemonHealth({ seconds_since_heartbeat: 181, metadata });
    expect(offline.status).toBe('offline');
    expect(offline.reasons).toEqual(['3 分钟未收到心跳']);
    expect(deriveDaemonHealth({ metadata }).status).toBe('offline');
  });
  test('ages the snapshot by the time since the heartbeat', () => {
    const metadata = JSON.stringify(snapshot());
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 100, metadata });
    expect(result.snapshot?.uptime_seconds).toBe(700);
    expect(result.snapshot?.last_message_read_success_age_seconds).toBe(102);
    expect(result.reasons).toEqual(['100 秒未收到心跳']);
    expect(result.status).toBe('degraded');
  });
  test('reports an interrupted reader and uploader', () => {
    const metadata = JSON.stringify(
      snapshot({
        last_message_read_success_age_seconds: null,
        last_upload_success_age_seconds: null,
        queue: {
          pending: 1,
          in_flight: 0,
          dead_letter: 0,
          oldest_unacknowledged_age_seconds: null,
        },
      }),
    );
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 1, metadata });
    expect(result.reasons).toEqual(['短信读取已中断', '消息上传已中断']);
  });
  test('accepts metadata that is already an object', () => {
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 1, metadata: snapshot() });
    expect(result.status).toBe('healthy');
  });
});
