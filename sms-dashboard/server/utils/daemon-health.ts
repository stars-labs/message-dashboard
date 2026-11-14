import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import {
  DAEMON_HEALTH_STATUSES,
  HEALTH_SCHEMA_VERSION,
  HealthSnapshot,
} from '../../shared/api/daemon-status.js';

/** Ages in seconds. `null` means "never happened". */
type Age = number | null;

type DaemonHealthStatus = (typeof DAEMON_HEALTH_STATUSES)[number];

interface DaemonHealth {
  status: DaemonHealthStatus;
  label: string;
  reasons: string[];
  snapshot: HealthSnapshot | null;
}

/** The daemon_health row columns this module reads. */
interface DaemonHealthRow {
  daemon_id?: string;
  last_heartbeat?: string | null;
  seconds_since_heartbeat?: unknown;
  metadata?: unknown;
}

function age(value: unknown): Age {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function text(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function describeVersion(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
    ? String(value)
    : 'missing';
}

/** The daemon upload is unknown: it crosses the daemon boundary and is read field by field. */
export function normalizeHealthSnapshot(raw: unknown): HealthSnapshot {
  const schemaVersion = field(raw, 'schema_version');
  if (schemaVersion !== HEALTH_SCHEMA_VERSION) {
    throw new Error(`Unsupported health schema version: ${describeVersion(schemaVersion)}`);
  }
  const session_id = text(field(raw, 'session_id'), 120);
  const version = text(field(raw, 'version'), 80);
  if (!session_id || !version) throw new Error('session_id and version are required');
  const queue = field(raw, 'queue');
  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    session_id,
    version,
    uptime_seconds: age(field(raw, 'uptime_seconds')) ?? 0,
    last_message_read_success_age_seconds: age(field(raw, 'last_message_read_success_age_seconds')),
    last_upload_success_age_seconds: age(field(raw, 'last_upload_success_age_seconds')),
    queue: {
      pending: age(field(queue, 'pending')) ?? 0,
      in_flight: age(field(queue, 'in_flight')) ?? 0,
      dead_letter: age(field(queue, 'dead_letter')) ?? 0,
      oldest_unacknowledged_age_seconds: age(field(queue, 'oldest_unacknowledged_age_seconds')),
    },
  };
}

function parseHealthSnapshot(metadata: unknown): HealthSnapshot | null {
  if (typeof metadata === 'string') {
    const parsed = parseJson(metadata, HealthSnapshot);
    return parsed.ok ? parsed.value : null;
  }
  const result = v.safeParse(HealthSnapshot, metadata);
  return result.success ? result.output : null;
}

/** Age every "seconds since" field by the time elapsed since the snapshot was taken. */
function advance(snapshot: HealthSnapshot, heartbeatAge: number): HealthSnapshot {
  if (!Number.isFinite(heartbeatAge)) return snapshot;
  const plus = (value: Age): Age => (value === null ? null : value + heartbeatAge);
  return {
    ...snapshot,
    uptime_seconds: snapshot.uptime_seconds + heartbeatAge,
    last_message_read_success_age_seconds: plus(snapshot.last_message_read_success_age_seconds),
    last_upload_success_age_seconds: plus(snapshot.last_upload_success_age_seconds),
    queue: {
      ...snapshot.queue,
      oldest_unacknowledged_age_seconds: plus(snapshot.queue.oldest_unacknowledged_age_seconds),
    },
  };
}

export function deriveDaemonHealth(row: DaemonHealthRow | null | undefined): DaemonHealth {
  if (!row) {
    return {
      status: 'unknown',
      label: '检测中',
      reasons: ['等待采集服务首次连接'],
      snapshot: null,
    };
  }
  const heartbeatAge = age(row.seconds_since_heartbeat) ?? Infinity;
  const stored = parseHealthSnapshot(row.metadata);
  if (!stored) {
    return {
      status: 'unknown',
      label: '检测中',
      reasons: ['健康报告格式无效或缺失'],
      snapshot: null,
    };
  }
  const snapshot = advance(stored, heartbeatAge);
  if (heartbeatAge > 180) {
    return {
      status: 'offline',
      label: '离线',
      reasons: [`${Math.floor(heartbeatAge / 60)} 分钟未收到心跳`],
      snapshot,
    };
  }
  const reasons: string[] = [];
  if (heartbeatAge > 90) reasons.push(`${Math.floor(heartbeatAge)} 秒未收到心跳`);
  if (
    snapshot.last_message_read_success_age_seconds === null ||
    snapshot.last_message_read_success_age_seconds > 300
  ) {
    reasons.push('短信读取已中断');
  }
  const queued = snapshot.queue.pending + snapshot.queue.in_flight;
  if (
    queued > 0 &&
    (snapshot.last_upload_success_age_seconds === null ||
      snapshot.last_upload_success_age_seconds > 300)
  ) {
    reasons.push('消息上传已中断');
  }
  if (
    snapshot.queue.oldest_unacknowledged_age_seconds !== null &&
    snapshot.queue.oldest_unacknowledged_age_seconds > 300
  ) {
    reasons.push('消息积压超过 5 分钟');
  }
  if (snapshot.queue.dead_letter > 0)
    reasons.push(`${snapshot.queue.dead_letter} 条消息需要人工处理`);
  return {
    status: reasons.length ? 'degraded' : 'healthy',
    label: reasons.length ? '部分异常' : '正常',
    reasons,
    snapshot,
  };
}
