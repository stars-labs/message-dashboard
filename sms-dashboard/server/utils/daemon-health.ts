export const HEALTH_SCHEMA_VERSION = 3;

/** Ages in seconds. `null` means "never happened"; the daemon omits them on first boot. */
type Age = number | null;

export interface HealthQueue {
  pending: number;
  in_flight: number;
  dead_letter: number;
  oldest_unacknowledged_age_seconds: Age;
}

/** The normalized snapshot the daemon uploads, stored as JSON in daemon_health.metadata. */
export interface HealthSnapshot {
  schema_version: typeof HEALTH_SCHEMA_VERSION;
  session_id: string;
  version: string;
  uptime_seconds: number;
  last_message_read_success_age_seconds: Age;
  last_upload_success_age_seconds: Age;
  queue: HealthQueue;
}

export type DaemonHealthStatus = 'unknown' | 'offline' | 'degraded' | 'healthy';

export interface DaemonHealth {
  status: DaemonHealthStatus;
  label: string;
  reasons: string[];
  snapshot: HealthSnapshot | null;
}

/** The daemon_health row columns this module reads. */
export interface DaemonHealthRow {
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

/** Raw upload shape. Everything is unknown because it crosses the daemon boundary. */
type RawSnapshot = Record<string, unknown> & {
  schema_version?: unknown;
  queue?: Record<string, unknown>;
};

export function normalizeHealthSnapshot(raw: RawSnapshot | null | undefined): HealthSnapshot {
  if (!raw || raw.schema_version !== HEALTH_SCHEMA_VERSION) {
    throw new Error(`Unsupported health schema version: ${raw?.schema_version ?? 'missing'}`);
  }
  const session_id = text(raw.session_id, 120);
  const version = text(raw.version, 80);
  if (!session_id || !version) throw new Error('session_id and version are required');
  const queue = raw.queue ?? {};
  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    session_id,
    version,
    uptime_seconds: age(raw.uptime_seconds) ?? 0,
    last_message_read_success_age_seconds: age(raw.last_message_read_success_age_seconds),
    last_upload_success_age_seconds: age(raw.last_upload_success_age_seconds),
    queue: {
      pending: age(queue.pending) ?? 0,
      in_flight: age(queue.in_flight) ?? 0,
      dead_letter: age(queue.dead_letter) ?? 0,
      oldest_unacknowledged_age_seconds: age(queue.oldest_unacknowledged_age_seconds),
    },
  };
}

export function parseHealthSnapshot(metadata: unknown): HealthSnapshot | null {
  try {
    const value = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    return value?.schema_version === HEALTH_SCHEMA_VERSION ? (value as HealthSnapshot) : null;
  } catch {
    return null;
  }
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
    return { status: 'unknown', label: '检测中', reasons: ['等待采集服务首次连接'], snapshot: null };
  }
  const heartbeatAge = age(row.seconds_since_heartbeat) ?? Infinity;
  const stored = parseHealthSnapshot(row.metadata);
  if (!stored) {
    return { status: 'unknown', label: '检测中', reasons: ['健康报告格式无效或缺失'], snapshot: null };
  }
  const snapshot = advance(stored, heartbeatAge);
  if (heartbeatAge > 180) {
    return { status: 'offline', label: '离线', reasons: [`${Math.floor(heartbeatAge / 60)} 分钟未收到心跳`], snapshot };
  }
  const reasons: string[] = [];
  if (heartbeatAge > 90) reasons.push(`${Math.floor(heartbeatAge)} 秒未收到心跳`);
  if (snapshot.last_message_read_success_age_seconds === null || snapshot.last_message_read_success_age_seconds > 300) {
    reasons.push('短信读取已中断');
  }
  const queued = snapshot.queue.pending + snapshot.queue.in_flight;
  if (queued > 0 && (snapshot.last_upload_success_age_seconds === null || snapshot.last_upload_success_age_seconds > 300)) {
    reasons.push('消息上传已中断');
  }
  if (snapshot.queue.oldest_unacknowledged_age_seconds !== null && snapshot.queue.oldest_unacknowledged_age_seconds > 300) {
    reasons.push('消息积压超过 5 分钟');
  }
  if (snapshot.queue.dead_letter > 0) reasons.push(`${snapshot.queue.dead_letter} 条消息需要人工处理`);
  return {
    status: reasons.length ? 'degraded' : 'healthy',
    label: reasons.length ? '部分异常' : '正常',
    reasons,
    snapshot,
  };
}