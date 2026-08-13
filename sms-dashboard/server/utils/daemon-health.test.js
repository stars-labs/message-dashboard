import { describe, expect, test } from 'bun:test';
import {
  deriveDaemonHealth,
  normalizeHealthSnapshot,
  parseHealthSnapshot,
} from './daemon-health.js';

function snapshot(overrides = {}) {
  return normalizeHealthSnapshot({
    schema_version: 1,
    session_id: 'rust-daemon-test',
    version: '8.0.0',
    uptime_seconds: 600,
    tasks: {
      modem_reader: { last_success_age_seconds: 2 },
      device_sync: { last_success_age_seconds: 14 },
      outbound_poll: { last_success_age_seconds: 3 },
      message_uploader: { last_success_age_seconds: 8 },
    },
    queue: { pending_uploads: 0 },
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
    expect(() => normalizeHealthSnapshot({ schema_version: 2 })).toThrow();
    expect(() => normalizeHealthSnapshot({ schema_version: 1, session_id: 'x' })).toThrow();
  });

  test('turns invalid numeric fields into safe defaults', () => {
    const value = snapshot({ queue: { pending_uploads: 'bad' } });
    expect(value.queue.pending_uploads).toBe(0);
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
    expect(result.legacy).toBe(false);
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
    const value = snapshot({ queue: { pending_uploads: 12 } });
    value.tasks.message_uploader.consecutive_failures = 3;
    value.tasks.message_uploader.last_error = 'network timeout';
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 2, metadata: JSON.stringify(value) });
    expect(result.status).toBe('degraded');
    expect(result.reasons[0]).toContain('network timeout');
  });

  test('marks a versioned daemon offline after 180 seconds', () => {
    const result = deriveDaemonHealth({ seconds_since_heartbeat: 181, metadata: JSON.stringify(snapshot()) });
    expect(result.status).toBe('offline');
  });

  test('keeps the five-minute threshold for legacy rows during rollout', () => {
    expect(deriveDaemonHealth({ seconds_since_heartbeat: 181, metadata: null }).status).toBe('degraded');
    expect(deriveDaemonHealth({ seconds_since_heartbeat: 301, metadata: null }).status).toBe('offline');
  });

  test('ignores malformed metadata as legacy input', () => {
    expect(parseHealthSnapshot('{bad')).toBeNull();
  });
});
