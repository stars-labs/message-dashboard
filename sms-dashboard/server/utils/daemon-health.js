export const HEALTH_SCHEMA_VERSION = 3;

function age(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function text(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

export function normalizeHealthSnapshot(raw) {
  if (!raw || raw.schema_version !== HEALTH_SCHEMA_VERSION) throw new Error(`Unsupported health schema version: ${raw?.schema_version ?? 'missing'}`);
  const session_id = text(raw.session_id, 120);
  const version = text(raw.version, 80);
  if (!session_id || !version) throw new Error('session_id and version are required');
  return {
    schema_version: HEALTH_SCHEMA_VERSION, session_id, version, uptime_seconds: age(raw.uptime_seconds) ?? 0,
    last_message_read_success_age_seconds: age(raw.last_message_read_success_age_seconds),
    last_upload_success_age_seconds: age(raw.last_upload_success_age_seconds),
    queue: {
      pending: age(raw.queue?.pending) ?? 0, in_flight: age(raw.queue?.in_flight) ?? 0,
      dead_letter: age(raw.queue?.dead_letter) ?? 0,
      oldest_unacknowledged_age_seconds: age(raw.queue?.oldest_unacknowledged_age_seconds),
    },
  };
}

export function parseHealthSnapshot(metadata) {
  try {
    const value = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    return value?.schema_version === HEALTH_SCHEMA_VERSION ? value : null;
  } catch { return null; }
}

function advance(snapshot, heartbeatAge) {
  if (!Number.isFinite(heartbeatAge)) return snapshot;
  const plus = (value) => value === null ? null : value + heartbeatAge;
  return {
    ...snapshot, uptime_seconds: snapshot.uptime_seconds + heartbeatAge,
    last_message_read_success_age_seconds: plus(snapshot.last_message_read_success_age_seconds),
    last_upload_success_age_seconds: plus(snapshot.last_upload_success_age_seconds),
    queue: { ...snapshot.queue, oldest_unacknowledged_age_seconds: plus(snapshot.queue.oldest_unacknowledged_age_seconds) },
  };
}

export function deriveDaemonHealth(row) {
  if (!row) return { status: 'unknown', label: '检测中', reasons: ['等待采集服务首次连接'], snapshot: null };
  const heartbeatAge = age(row.seconds_since_heartbeat) ?? Infinity;
  const stored = parseHealthSnapshot(row.metadata);
  if (!stored) return { status: 'unknown', label: '检测中', reasons: ['健康报告格式无效或缺失'], snapshot: null };
  const snapshot = advance(stored, heartbeatAge);
  if (heartbeatAge > 180) return { status: 'offline', label: '离线', reasons: [`${Math.floor(heartbeatAge / 60)} 分钟未收到心跳`], snapshot };
  const reasons = [];
  if (heartbeatAge > 90) reasons.push(`${Math.floor(heartbeatAge)} 秒未收到心跳`);
  if (snapshot.last_message_read_success_age_seconds === null || snapshot.last_message_read_success_age_seconds > 300) reasons.push('短信读取已中断');
  const queued = snapshot.queue.pending + snapshot.queue.in_flight;
  if (queued > 0 && (snapshot.last_upload_success_age_seconds === null || snapshot.last_upload_success_age_seconds > 300)) reasons.push('消息上传已中断');
  if (snapshot.queue.oldest_unacknowledged_age_seconds !== null && snapshot.queue.oldest_unacknowledged_age_seconds > 300) reasons.push('消息积压超过 5 分钟');
  if (snapshot.queue.dead_letter > 0) reasons.push(`${snapshot.queue.dead_letter} 条消息需要人工处理`);
  return { status: reasons.length ? 'degraded' : 'healthy', label: reasons.length ? '部分异常' : '正常', reasons, snapshot };
}
