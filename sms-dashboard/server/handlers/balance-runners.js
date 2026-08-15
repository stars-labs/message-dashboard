import { authorizeRunnerControl, RUNNER_SCOPES } from '../utils/runner-auth.js';

const CAPABILITIES = new Set(['sms_ai', 'unicom_browser']);
const STATES = new Set([
  'starting',
  'ready',
  'busy',
  'degraded',
  'configuration_required',
  'stopping',
]);
const ONLINE_SECONDS = 90;

function json(data, status = 200) {
  return Response.json(data, { status });
}

function boundedString(value, max, required = true) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) return null;
  return normalized;
}

function parseHeartbeat(body) {
  const runnerId = boundedString(body?.runner_id, 200);
  const sessionId = boundedString(body?.session_id, 200);
  const displayName = boundedString(body?.display_name, 200);
  const platform = boundedString(body?.platform, 100);
  const version = boundedString(body?.version, 100);
  if (!runnerId || !sessionId || !displayName || !platform || !version) return null;
  if (!Array.isArray(body.capabilities) || body.capabilities.length < 1
    || body.capabilities.length > CAPABILITIES.size) return null;

  const seen = new Set();
  const capabilities = [];
  for (const item of body.capabilities) {
    const capability = boundedString(item?.capability, 100);
    const state = boundedString(item?.state, 100);
    const currentJobId = item?.current_job_id == null
      ? null
      : boundedString(item.current_job_id, 200);
    const detailCode = item?.detail_code == null ? null : boundedString(item.detail_code, 100);
    const concurrency = Number(item?.concurrency ?? 1);
    if (!CAPABILITIES.has(capability) || !STATES.has(state) || seen.has(capability)
      || (item?.current_job_id != null && !currentJobId)
      || (item?.detail_code != null && !detailCode)
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) return null;
    seen.add(capability);
    capabilities.push({ capability, state, currentJobId, detailCode, concurrency });
  }

  return { runnerId, sessionId, displayName, platform, version, capabilities };
}

function capabilitySummary(rows) {
  const result = {};
  for (const capability of CAPABILITIES) {
    const candidates = rows.filter((row) => row.capability === capability);
    const online = candidates.filter((row) => Number(row.seconds_since_heartbeat) <= ONLINE_SECONDS
      && row.state !== 'stopping');
    const ready = online.find((row) => ['ready', 'busy'].includes(row.state));
    const selected = ready || online[0] || candidates[0] || null;
    result[capability] = {
      available: Boolean(ready),
      state: selected
        ? (Number(selected.seconds_since_heartbeat) > ONLINE_SECONDS ? 'offline' : selected.state)
        : 'offline',
      runner_id: selected?.runner_id || null,
      current_job_id: selected?.current_job_id || null,
      detail_code: selected?.detail_code || null,
      last_heartbeat: selected?.last_heartbeat || null,
    };
  }
  return result;
}

export async function loadBalanceRunnerStatus(db, { authSubject = null } = {}) {
  const ownerFilter = authSubject
    ? " AND auth_mode = 'auth0_device' AND auth_subject = ?"
    : '';
  const capabilityOwnerFilter = authSubject
    ? " AND r.auth_mode = 'auth0_device' AND r.auth_subject = ?"
    : '';
  const installationStatement = db.prepare(`
      SELECT id, display_name, auth_mode, platform, version, last_heartbeat,
        CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER)
          AS seconds_since_heartbeat
      FROM balance_runner_installations
      WHERE revoked_at IS NULL${ownerFilter}
      ORDER BY datetime(last_heartbeat) DESC, id
    `);
  const capabilityStatement = db.prepare(`
      SELECT c.runner_id, c.capability, c.state, c.current_job_id, c.concurrency,
        c.detail_code, c.last_heartbeat,
        CAST((julianday('now') - julianday(c.last_heartbeat)) * 86400 AS INTEGER)
          AS seconds_since_heartbeat
      FROM balance_runner_capabilities c
      JOIN balance_runner_installations r ON r.id = c.runner_id
      WHERE r.revoked_at IS NULL${capabilityOwnerFilter}
      ORDER BY datetime(c.last_heartbeat) DESC, c.runner_id
    `);
  const [installations, capabilityRows] = await Promise.all([
    authSubject ? installationStatement.bind(authSubject).all() : installationStatement.all(),
    authSubject ? capabilityStatement.bind(authSubject).all() : capabilityStatement.all(),
  ]);

  const rows = capabilityRows.results || [];
  return {
    online_seconds: ONLINE_SECONDS,
    capabilities: capabilitySummary(rows),
    runners: (installations.results || []).map((runner) => ({
      ...runner,
      online: Number(runner.seconds_since_heartbeat) <= ONLINE_SECONDS,
      capabilities: rows.filter((row) => row.runner_id === runner.id),
    })),
  };
}

export const balanceRunnersHandler = {
  async check(request) {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.heartbeat);
    if (!auth.authorized) return json({ error: 'Unauthorized' }, 401);
    return json({ success: true });
  },

  async heartbeat(request) {
    const auth = await authorizeRunnerControl(request, RUNNER_SCOPES.heartbeat);
    if (!auth.authorized) return json({ error: 'Unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const heartbeat = parseHeartbeat(body);
    if (!heartbeat) return json({ error: 'Invalid runner heartbeat' }, 400);

    const existing = await request.env.DB.prepare(`
      SELECT auth_mode, auth_subject, revoked_at
      FROM balance_runner_installations WHERE id = ?
    `).bind(heartbeat.runnerId).first();
    if (existing?.revoked_at) return json({ error: 'Runner installation is revoked' }, 403);
    if (existing && (existing.auth_mode !== auth.authMode
      || (auth.authMode === 'auth0_device' && existing.auth_subject !== auth.subject))) {
      return json({ error: 'Runner identity does not match this installation' }, 409);
    }

    const statements = [request.env.DB.prepare(`
      INSERT INTO balance_runner_installations (
        id, display_name, auth_mode, auth_subject, platform, version, last_heartbeat
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        auth_mode = excluded.auth_mode,
        auth_subject = excluded.auth_subject,
        platform = excluded.platform,
        version = excluded.version,
        last_heartbeat = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE balance_runner_installations.revoked_at IS NULL
    `).bind(
      heartbeat.runnerId,
      heartbeat.displayName,
      auth.authMode,
      auth.subject,
      heartbeat.platform,
      heartbeat.version,
    )];

    for (const capability of heartbeat.capabilities) {
      statements.push(request.env.DB.prepare(`
        INSERT INTO balance_runner_capabilities (
          runner_id, capability, state, session_id, current_job_id,
          concurrency, detail_code, last_heartbeat
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(runner_id, capability) DO UPDATE SET
          state = excluded.state,
          session_id = excluded.session_id,
          current_job_id = excluded.current_job_id,
          concurrency = excluded.concurrency,
          detail_code = excluded.detail_code,
          last_heartbeat = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        heartbeat.runnerId,
        capability.capability,
        capability.state,
        heartbeat.sessionId,
        capability.currentJobId,
        capability.concurrency,
        capability.detailCode,
      ));
    }

    await request.env.DB.batch(statements);
    return json({ success: true, runner_id: heartbeat.runnerId });
  },

  async status(request) {
    const authSubject = request.user?.id;
    if (!authSubject) return json({ error: 'Unauthorized' }, 401);
    return json({
      success: true,
      ...(await loadBalanceRunnerStatus(request.env.DB, { authSubject })),
    });
  },
};
