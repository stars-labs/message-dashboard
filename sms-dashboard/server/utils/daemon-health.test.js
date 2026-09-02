import { describe, expect, test } from 'bun:test';
import {
  deriveDaemonHealth,
  normalizeHealthSnapshot,
  parseHealthSnapshot,
} from './daemon-health.js';

function snapshot(overrides = {}) {
  return normalizeHealthSnapshot({
    schema_version: 2,
    session_id: 'rust-daemon-test',
    version: '8.0.0',
    uptime_seconds: 600,
    tasks: {
      modem_reader: { last_success_age_seconds: 2 },
      device_sync: { last_success_age_seconds: 14 },
      outbound_poll: { last_success_age_seconds: 3 },
      message_uploader: { last_success_age_seconds: 8 },
    },
    queue: { retryable: 0, attempts_exhausted: 0, stuck_uploading: 0 },
    modems: { discovered: 93, responsive: 92, sim_readable: 91 },
    ...overrides,
  });
}

describe('normalizeHealthSnapshot', () => {
  test('keeps the versioned, bounded health contract', () => {
    expect(snapshot().tasks.modem_reader.last_success_age_seconds).toBe(2);
    expect(snapshot().modems.responsive).toBe(92);
  });

  test('rejects missing versions and schema mismatches', () => {
    expect(() => normalizeHealthSnapshot({ schema_version: 1 })).toThrow();
    expect(() => normalizeHealthSnapshot({ schema_version: 2, session_id: 'x' })).toThrow();
  });

  test('turns invalid numeric fields into safe defaults', () => {
    const value = snapshot({
      queue: { retryable: 'bad', attempts_exhausted: -1, stuck_uploading: null },
    });
    expect(value.queue).toEqual({ retryable: 0, attempts_exhausted: 0, stuck_uploading: 0 });
  });

  test('preserves missing task timestamps as missing', () => {
    const value = snapshot({ tasks: {} });
    expect(value.tasks.modem_reader.last_success_age_seconds).toBeNull();
  });
});

describe('deriveDaemonHealth', () => {
  test('reports unknown before the first heartbeat', () => {
    expect(deriveDaemonHealth(null).status).toBe('unknown');
  });

  test('reports a healthy versioned daemon', () => {
    const result = deriveDaemonHealth({
      seconds_since_heartbeat: 3,
      metadata: JSON.stringify(snapshot()),
    });
    expect(result.status).toBe('healthy');
    expect(result.reasons).toEqual([]);
  });

  test('detects a stalled reader while the heartbeat remains current', () => {
    const value = snapshot();
    value.tasks.modem_reader.last_success_age_seconds = 130;
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) });
    expect(result.status).toBe('degraded');
    expect(result.reasons[0]).toContain('短信扫描');
  });

  test('advances task ages after the snapshot was received', () => {
    const value = snapshot();
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 80, metadata: JSON.stringify(value) });
    expect(result.status).toBe('degraded');
    expect(result.reasons[0]).toContain('设备同步');
    expect(result.snapshot.tasks.device_sync.last_success_age_seconds).toBe(94);
  });

  test('does not degrade an idle uploader with an empty queue', () => {
    const value = snapshot();
    value.tasks.message_uploader.last_success_age_seconds = 999;
    expect(deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) }).status).toBe('healthy');
  });

  test('degrades a failing uploader when messages are queued', () => {
    const value = snapshot({
      queue: { retryable: 12, attempts_exhausted: 0, stuck_uploading: 0 },
    });
    value.tasks.message_uploader.consecutive_failures = 3;
    value.tasks.message_uploader.last_error = 'network timeout';
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) });
    expect(result.status).toBe('degraded');
    expect(result.reasons[0]).toContain('network timeout');
  });

  test('reports exhausted and stuck local messages even without a current upload failure', () => {
    const value = snapshot({
      queue: { retryable: 0, attempts_exhausted: 76, stuck_uploading: 3 },
    });
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) });

    expect(result.status).toBe('degraded');
    expect(result.reasons).toEqual([
      '76 条消息已耗尽重试次数',
      '3 条消息卡在上传中',
    ]);
  });

  test('marks a versioned daemon offline after 180 seconds', () => {
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 181, metadata: JSON.stringify(snapshot()) });
    expect(result.status).toBe('offline');
  });

  test('rejects missing and old health snapshots instead of inventing legacy health', () => {
    expect(deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: null }).status).toBe('unknown');
    expect(deriveDaemonHealth({
      seconds_since_heartbeat: 2,
      metadata: JSON.stringify({ schema_version: 1 }),
    }).status).toBe('unknown');
  });

  test('rejects malformed metadata', () => {
    expect(parseHealthSnapshot('{bad')).toBeNull();
    expect(deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: '{bad' }).status).toBe('unknown');
  });
});
