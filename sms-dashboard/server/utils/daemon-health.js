export const HEALTH_SCHEMA_VERSION = 1;

export const HEALTH_TASKS = {
  modem_reader: { label: '短信扫描', degradedAfter: 120, criticalAfter: 300 },
  device_sync: { label: '设备同步', degradedAfter: 90, criticalAfter: 300 },
  outbound_poll: { label: '发送轮询', degradedAfter: 45, criticalAfter: 180 },
  message_uploader: { label: '消息上传', degradedAfter: 120, criticalAfter: 300 },
};

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function shortString(value, maxLength = 500) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function normalizeTask(raw = {}) {
  return {
    last_attempt_age_seconds: finiteNonNegative(raw.last_attempt_age_seconds),
    last_success_age_seconds: finiteNonNegative(raw.last_success_age_seconds),
    consecutive_failures: finiteNonNegative(raw.consecutive_failures) ?? 0,
    last_error: shortString(raw.last_error),
  };
}

/** Validate and bound a versioned health report before it is persisted. */
export function normalizeHealthSnapshot(raw) {
  if (!raw || raw.schema_version !== HEALTH_SCHEMA_VERSION) {
    throw new Error(`Unsupported health schema version: ${raw?.schema_version ?? 'missing'}`);
  }

  const sessionId = shortString(raw.session_id, 120);
  const version = shortString(raw.version, 80);
  if (!sessionId || !version) throw new Error('session_id and version are required');

  const tasks = {};
  for (const name of Object.keys(HEALTH_TASKS)) tasks[name] = normalizeTask(raw.tasks?.[name]);

  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    session_id: sessionId,
    version,
    uptime_seconds: finiteNonNegative(raw.uptime_seconds) ?? 0,
    tasks,
    queue: {
      pending_uploads: finiteNonNegative(raw.queue?.pending_uploads) ?? 0,
    },
    modems: {
      discovered: finiteNonNegative(raw.modems?.discovered) ?? 0,
      responsive: finiteNonNegative(raw.modems?.responsive) ?? 0,
      sim_readable: finiteNonNegative(raw.modems?.sim_readable) ?? 0,
    },
  };
}

export function parseHealthSnapshot(metadata) {
  if (!metadata) return null;
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    return parsed?.schema_version === HEALTH_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function advanceSnapshotAges(snapshot, heartbeatAge) {
  if (!snapshot || !Number.isFinite(heartbeatAge)) return snapshot;
  const tasks = {};
  for (const [name, task] of Object.entries(snapshot.tasks || {})) {
    tasks[name] = { ...task };
    for (const field of ['last_attempt_age_seconds', 'last_success_age_seconds']) {
      const age = finiteNonNegative(task?.[field]);
      tasks[name][field] = age === null ? null : age + heartbeatAge;
    }
  }
  return {
    ...snapshot,
    uptime_seconds: (finiteNonNegative(snapshot.uptime_seconds) ?? 0) + heartbeatAge,
    tasks,
  };
}

function taskReason(name, task, snapshot) {
  const config = HEALTH_TASKS[name];
  if (name === 'message_uploader' && (snapshot.queue?.pending_uploads ?? 0) === 0) return null;

  const age = finiteNonNegative(task?.last_success_age_seconds);
  const failures = finiteNonNegative(task?.consecutive_failures) ?? 0;
  if (failures >= 3) {
    return `${config.label}连续失败 ${failures} 次${task?.last_error ? `：${task.last_error}` : ''}`;
  }
  if (age === null) {
    return snapshot.uptime_seconds > config.degradedAfter ? `${config.label}尚未成功运行` : null;
  }
  if (age > config.criticalAfter) return `${config.label}已中断 ${Math.floor(age / 60)} 分钟`;
  if (age > config.degradedAfter) return `${config.label}已延迟 ${Math.floor(age)} 秒`;
  return null;
}

/**
 * Derive the public service status from one daemon_health row.
 * `seconds_since_heartbeat` must be calculated by D1, not by the daemon clock.
 */
export function deriveDaemonHealth(row) {
  if (!row) {
    return {
      status: 'unknown',
      label: '检测中',
      reasons: ['等待采集服务首次连接'],
      legacy: false,
      snapshot: null,
    };
  }

  const heartbeatAge = finiteNonNegative(row.seconds_since_heartbeat) ?? Number.POSITIVE_INFINITY;
  const storedSnapshot = parseHealthSnapshot(row.metadata);
  const snapshot = advanceSnapshotAges(storedSnapshot, heartbeatAge);
  const legacy = !storedSnapshot;
  const offlineAfter = legacy ? 300 : 180;
  const degradedAfter = legacy ? 120 : 90;

  if (heartbeatAge > offlineAfter) {
    return {
      status: 'offline',
      label: '离线',
      reasons: [`${Math.floor(heartbeatAge / 60)} 分钟未收到心跳`],
      legacy,
      snapshot,
    };
  }

  const reasons = [];
  if (heartbeatAge > degradedAfter) reasons.push(`${Math.floor(heartbeatAge)} 秒未收到心跳`);
  if (snapshot) {
    for (const name of Object.keys(HEALTH_TASKS)) {
      const reason = taskReason(name, snapshot.tasks?.[name], snapshot);
      if (reason) reasons.push(reason);
    }
  }

  return {
    status: reasons.length ? 'degraded' : 'healthy',
    label: reasons.length ? '部分异常' : '正常',
    reasons,
    legacy,
    snapshot,
  };
}
