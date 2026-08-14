import { nanoid } from 'nanoid';
import { senderMatches } from '../utils/spam-filter.js';

const REPLYABLE_CHECK_STATUS = 'awaiting_response';
const CHINA_MOBILE_NAMES = ['china mobile', 'cmcc', '中国移动', '移动'];

function json(data, status = 200) {
  return Response.json(data, { status });
}

function hasApiKey(request) {
  const actual = request.headers.get('X-API-Key');
  return Boolean(actual && actual === request.env.API_KEY);
}

function normalizeCarrier(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function parseConversationSteps(value) {
  try {
    const steps = JSON.parse(value || '[]');
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}

function matchingNextStep(check, content) {
  const step = parseConversationSteps(check?.conversation_steps)[check?.step_index || 0];
  if (!step || typeof step.response_contains !== 'string'
    || typeof step.command !== 'string') return null;
  return String(content || '').includes(step.response_contains) ? step : null;
}

function attemptedStep(check) {
  const stepIndex = Number(check?.step_index || 0) - 1;
  if (stepIndex < 0) return null;
  const step = parseConversationSteps(check?.conversation_steps)[stepIndex];
  return step && typeof step.command === 'string' ? step : null;
}

export function parseBalanceMetrics(parserVersion, content) {
  if (parserVersion !== 'cn-mobile-balance-v1' || typeof content !== 'string') return [];

  const cashMatch = content.match(/(?:账户|话费|可用)?余额(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/);
  if (!cashMatch) return [];

  return [{
    metric_type: 'cash_balance',
    value: Number(cashMatch[1]),
    unit: null,
    currency: 'CNY',
    expires_at: null,
  }];
}

export function carrierMatchesProfile(actualCarrier, profileCarrier) {
  const actual = normalizeCarrier(actualCarrier);
  const expected = normalizeCarrier(profileCarrier);
  if (!actual || !expected) return false;
  if (actual === expected) return true;

  if (CHINA_MOBILE_NAMES.includes(expected)) {
    return CHINA_MOBILE_NAMES.some((name) => actual.includes(name));
  }

  return actual.includes(expected) || expected.includes(actual);
}

export function expectedSenderMatches(rawSender, expectedSendersJson) {
  let expected;
  try {
    expected = JSON.parse(expectedSendersJson);
  } catch {
    return false;
  }

  return Array.isArray(expected)
    && expected.some((sender) => senderMatches(rawSender, sender));
}

export async function findPendingBalanceCheck(db, { phone_iccid, phone_number }) {
  if (!phone_iccid || !phone_number) return null;

  const result = await db.prepare(`
    SELECT
      c.id,
      c.sim_iccid,
      c.profile_id,
      c.parser_version,
      c.step_index,
      p.expected_senders,
      p.response_window_minutes,
      p.conversation_steps,
      p.destination,
      dv.number AS sim_number
    FROM sim_balance_checks c
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
    WHERE c.sim_iccid = ?
      AND c.status = ?
      AND datetime(COALESCE((
        SELECT MAX(m.timestamp)
        FROM messages m
        WHERE m.balance_check_id = c.id AND m.type = 'sent'
      ), c.requested_at)) >= datetime(
        'now', '-' || p.response_window_minutes || ' minutes'
      )
    ORDER BY c.requested_at DESC
  `).bind(phone_iccid, REPLYABLE_CHECK_STATUS).all();

  const candidates = result.results || [];
  return candidates.find((candidate) =>
    expectedSenderMatches(phone_number, candidate.expected_senders)
  ) || null;
}

export async function linkBalanceReply(db, check, message) {
  if (!check) return;

  const nextStep = matchingNextStep(check, message.content);
  if (nextStep) {
    return queueBalanceFollowUp(db, check, message, nextStep, 'awaiting_response');
  }

  const metrics = parseBalanceMetrics(check.parser_version, message.content);
  const statements = [db.prepare(`
    UPDATE sim_balance_checks
    SET status = ?,
        completed_at = CURRENT_TIMESTAMP,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'awaiting_response'
  `).bind(
    metrics.length ? 'parsed' : 'response_received',
    message.id,
    message.phone_number,
    message.content,
    check.id,
  )];

  for (const metric of metrics) {
    statements.push(db.prepare(`
      INSERT INTO sim_balance_metrics (
        check_id, metric_type, value, unit, currency, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id, metric_type) DO UPDATE SET
        value = excluded.value,
        unit = excluded.unit,
        currency = excluded.currency,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `).bind(
      check.id,
      metric.metric_type,
      metric.value,
      metric.unit,
      metric.currency,
      metric.expires_at,
    ));
  }

  return db.batch(statements);
}

async function queueBalanceFollowUp(db, check, message, step, fromStatus) {
  const messageId = `msg-balance-${nanoid()}`;
  const results = await db.batch([
    db.prepare(`
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      )
      SELECT ?, c.sim_iccid, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
        'sending', 'filtered', 'balance_maintenance', c.id
      FROM sim_balance_checks c
      WHERE c.id = ? AND c.status = ? AND c.step_index = ?
    `).bind(
      messageId,
      check.sim_number || null,
      step.command,
      check.destination,
      check.id,
      fromStatus,
      check.step_index || 0,
    ),
    db.prepare(`
    UPDATE sim_balance_checks
    SET status = 'queued',
        step_index = step_index + 1,
        completed_at = NULL,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = ?
      AND step_index = ?
    `).bind(
      message.id,
      message.phone_number,
      message.content,
      check.id,
      fromStatus,
      check.step_index || 0,
    ),
  ]);

  const queued = Number(results?.[0]?.meta?.changes ?? 1) > 0;
  return { queued, message_id: queued ? messageId : null };
}

export async function updateBalanceCheckForSmsResult(
  db,
  messageId,
  success,
  errorMessage = null,
) {
  await db.prepare(`
    UPDATE sim_balance_checks
    SET status = ?,
        sent_at = CASE WHEN ? THEN COALESCE(sent_at, CURRENT_TIMESTAMP) ELSE sent_at END,
        completed_at = CASE WHEN ? THEN completed_at ELSE CURRENT_TIMESTAMP END,
        error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT balance_check_id FROM messages WHERE id = ?
    )
      AND status = 'queued'
  `).bind(
    success ? 'awaiting_response' : 'failed',
    success ? 1 : 0,
    success ? 1 : 0,
    success ? null : (errorMessage || 'SMS send failed'),
    messageId,
  ).run();
}

export const balanceQueriesHandler = {
  async list(request) {
    const url = new URL(request.url);
    const phoneIccid = url.searchParams.get('phone_iccid');
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 100;
    const conditions = [];
    const params = [];

    if (phoneIccid) {
      conditions.push('c.sim_iccid = ?');
      params.push(phoneIccid);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await request.env.DB.prepare(`
      SELECT
        c.id,
        c.sim_iccid,
        c.profile_id,
        c.requested_at,
        c.sent_at,
        c.completed_at,
        c.status,
        c.step_index,
        c.response_sender,
        c.raw_response,
        c.error,
        c.parser_version,
        p.country_code,
        p.carrier AS profile_carrier,
        p.method,
        p.command,
        p.destination,
        p.conversation_steps,
        dv.sim_index,
        dv.number AS sim_number,
        dv.carrier AS sim_carrier,
        dv.country AS sim_country,
        om.content AS outbound_content,
        om.recipient AS outbound_recipient,
        om.timestamp AS outbound_timestamp,
        om.status AS outbound_status,
        rm.content AS response_content,
        rm.phone_number AS response_phone_number,
        rm.timestamp AS response_timestamp,
        COALESCE((
          SELECT json_group_array(json_object(
            'id', conversation.id,
            'type', conversation.type,
            'content', conversation.content,
            'timestamp', conversation.timestamp,
            'status', conversation.status,
            'phone_number', conversation.phone_number,
            'recipient', conversation.recipient
          ))
          FROM (
            SELECT m.id, m.type, m.content, m.timestamp, m.status,
                   m.phone_number, m.recipient
            FROM messages m
            WHERE m.balance_check_id = c.id
            ORDER BY datetime(m.timestamp), m.rowid
          ) conversation
        ), '[]') AS conversation_json,
        COALESCE((
          SELECT json_group_array(json_object(
            'metric_type', bm.metric_type,
            'value', bm.value,
            'unit', bm.unit,
            'currency', bm.currency,
            'expires_at', bm.expires_at
          ))
          FROM sim_balance_metrics bm
          WHERE bm.check_id = c.id
        ), '[]') AS metrics_json
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
      LEFT JOIN messages om ON om.id = c.outbound_message_id
      LEFT JOIN messages rm ON rm.id = c.response_message_id
      ${where}
      ORDER BY datetime(c.requested_at) DESC
      LIMIT ?
    `).bind(...params, limit).all();

    const checks = (result.results || []).map((check) => {
      let metrics = [];
      let conversation = [];
      try {
        metrics = JSON.parse(check.metrics_json || '[]');
      } catch {
        metrics = [];
      }
      try {
        conversation = JSON.parse(check.conversation_json || '[]');
      } catch {
        conversation = [];
      }
      const {
        metrics_json: _metricsJson,
        conversation_json: _conversationJson,
        ...record
      } = check;
      return { ...record, metrics, conversation };
    });

    return json({ success: true, data: checks });
  },

  async create(request) {
    if (!hasApiKey(request)) return json({ error: 'Unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const { phone_iccid, profile_id } = body || {};
    if (typeof phone_iccid !== 'string' || typeof profile_id !== 'string') {
      return json({
        success: false,
        error: 'phone_iccid and profile_id are required',
      }, 400);
    }

    const db = request.env.DB;
    const [profile, phone, recent] = await Promise.all([
      db.prepare(`
        SELECT * FROM sim_balance_profiles
        WHERE id = ? AND (discovery_enabled = 1 OR enabled = 1)
      `).bind(profile_id).first(),
      db.prepare(`
        SELECT iccid, number, carrier, country, sim_status
        FROM device_view WHERE iccid = ?
      `).bind(phone_iccid).first(),
      db.prepare(`
        SELECT id, status, requested_at
        FROM sim_balance_checks
        WHERE sim_iccid = ?
          AND status != 'failed'
          AND datetime(requested_at) >= datetime('now', '-24 hours')
        ORDER BY requested_at DESC LIMIT 1
      `).bind(phone_iccid).first(),
    ]);

    if (!profile) {
      return json({ success: false, error: 'Balance profile is not enabled' }, 404);
    }
    if (profile.method !== 'sms') {
      return json({ success: false, error: 'Profile method is not implemented' }, 400);
    }
    if (!phone || phone.sim_status !== 'active') {
      return json({ success: false, error: 'SIM is not active' }, 409);
    }
    if (phone.country !== profile.country_code
      || !carrierMatchesProfile(phone.carrier, profile.carrier)) {
      return json({ success: false, error: 'SIM does not match the carrier profile' }, 409);
    }
    if (recent) {
      return json({
        success: false,
        error: 'This SIM has already been queried in the last 24 hours',
        previous_check: recent,
      }, 429);
    }

    const checkId = `bal-${nanoid()}`;
    const messageId = `msg-balance-${nanoid()}`;

    await db.batch([
      db.prepare(`
        INSERT INTO sim_balance_checks (
          id, sim_iccid, profile_id, status, outbound_message_id, parser_version
        ) VALUES (?, ?, ?, 'queued', ?, ?)
      `).bind(checkId, phone_iccid, profile_id, messageId, profile.parser_version),
      db.prepare(`
        INSERT INTO messages (
          id, phone_iccid, phone_number, content, timestamp, type, recipient,
          status, filter_status, purpose, balance_check_id
        ) VALUES (
          ?, ?, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
          'sending', 'filtered', 'balance_maintenance', ?
        )
      `).bind(
        messageId,
        phone_iccid,
        phone.number,
        profile.command,
        profile.destination,
        checkId,
      ),
    ]);

    return json({
      success: true,
      check: {
        id: checkId,
        sim_iccid: phone_iccid,
        profile_id,
        status: 'queued',
        outbound_message_id: messageId,
      },
    }, 202);
  },

  async continue(request) {
    if (!hasApiKey(request)) return json({ error: 'Unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    if (typeof body?.check_id !== 'string') {
      return json({ success: false, error: 'check_id is required' }, 400);
    }

    const check = await request.env.DB.prepare(`
      SELECT
        c.id, c.sim_iccid, c.status, c.step_index, c.response_message_id,
        c.response_sender, c.raw_response, c.parser_version,
        p.destination, p.conversation_steps,
        dv.number AS sim_number
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
      WHERE c.id = ?
    `).bind(body.check_id).first();

    if (!check) return json({ success: false, error: 'Balance check not found' }, 404);
    if (!['response_received', 'unparsed'].includes(check.status)) {
      return json({ success: false, error: 'Balance check cannot be continued' }, 409);
    }

    const step = matchingNextStep(check, check.raw_response);
    if (!step) {
      return json({ success: false, error: 'No allowlisted next step matches the reply' }, 409);
    }

    const result = await queueBalanceFollowUp(request.env.DB, check, {
      id: check.response_message_id,
      phone_number: check.response_sender,
      content: check.raw_response,
    }, step, check.status);

    if (!result.queued) {
      return json({ success: false, error: 'Balance check changed before it was continued' }, 409);
    }

    return json({
      success: true,
      check: {
        id: check.id,
        status: 'queued',
        step_index: (check.step_index || 0) + 1,
        outbound_message_id: result.message_id,
      },
    }, 202);
  },

  async retry(request) {
    if (!hasApiKey(request)) return json({ error: 'Unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    if (typeof body?.check_id !== 'string') {
      return json({ success: false, error: 'check_id is required' }, 400);
    }

    const check = await request.env.DB.prepare(`
      SELECT
        c.id, c.status, c.step_index,
        p.destination, p.conversation_steps,
        m.id AS message_id, m.content AS message_content,
        m.recipient AS message_recipient, m.status AS message_status
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      JOIN messages m ON m.id = (
        SELECT latest.id
        FROM messages latest
        WHERE latest.balance_check_id = c.id
          AND latest.type = 'sent'
          AND latest.purpose = 'balance_maintenance'
        ORDER BY datetime(latest.timestamp) DESC, latest.rowid DESC
        LIMIT 1
      )
      WHERE c.id = ?
    `).bind(body.check_id).first();

    const step = attemptedStep(check);
    if (!check || check.status !== 'failed' || check.message_status !== 'failed'
      || !step || check.message_content !== step.command
      || check.message_recipient !== check.destination) {
      return json({ success: false, error: 'No allowlisted failed step can be retried' }, 409);
    }

    const results = await request.env.DB.batch([
      request.env.DB.prepare(`
        UPDATE messages
        SET status = 'sending', error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed'
          AND purpose = 'balance_maintenance'
      `).bind(check.message_id),
      request.env.DB.prepare(`
        UPDATE sim_balance_checks
        SET status = 'queued', completed_at = NULL, error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed' AND step_index = ?
      `).bind(check.id, check.step_index),
    ]);

    if (Number(results?.[0]?.meta?.changes ?? 1) === 0
      || Number(results?.[1]?.meta?.changes ?? 1) === 0) {
      return json({ success: false, error: 'Balance check changed before retry' }, 409);
    }

    return json({
      success: true,
      check: {
        id: check.id,
        status: 'queued',
        step_index: check.step_index,
        outbound_message_id: check.message_id,
      },
    }, 202);
  },
};
