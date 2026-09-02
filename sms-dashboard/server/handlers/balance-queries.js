import { nanoid } from 'nanoid';
import { senderMatches } from '../utils/spam-filter.js';
import { parseBalanceSkillConfig } from '../utils/balance-skill.js';
import {
  createCarrierWebBalanceStatements,
  newCarrierWebBalanceIds,
} from './carrier-web-balance.js';
import { loadBalanceRunnerStatus } from './balance-runners.js';

const CHINA_MOBILE_NAMES = ['china mobile', 'cmcc', '中国移动', '移动'];
const CHINA_UNICOM_NAMES = ['china unicom', 'unicom', '中国联通', '联通'];
const CHINA_TELECOM_NAMES = ['china telecom', 'telecom', 'ctcc', '中国电信', '电信'];
const CMHK_NAMES = ['cmhk', 'china mobile hong kong', '中国移动香港', '中移香港', '香港移动'];
const BATCH_METHODS = new Set(['direct_sms', 'sms_ai', 'browser']);
const MAX_BATCH_SCOPE = 500;
const BALANCE_COOLDOWN_PREDICATE = `
  status IN ('queued', 'awaiting_response')
  OR (status IN ('response_received', 'parsed', 'unparsed')
    AND datetime(requested_at) >= datetime('now', '-24 hours'))
`;

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

function checkKey(simIccid, profileId) {
  return `${simIccid}\u0000${profileId}`;
}

function requiredServiceType(profile) {
  try {
    const parsed = JSON.parse(profile?.skill_config || '{}');
    return typeof parsed.required_service_type === 'string'
      ? parsed.required_service_type
      : null;
  } catch {
    return null;
  }
}

function parseBatchScope(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_SCOPE) return null;
  const normalized = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (normalized.some((item) => !item || item.length > 64)) return null;
  if (new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

export function buildBalanceQueryPlan({
  phones = [],
  profiles = [],
  recentChecks = [],
  successfulChecks = [],
  allowDiscovery = false,
} = {}) {
  const recentBySim = new Map(recentChecks.map((check) => [check.sim_iccid, check]));
  const successful = new Set(
    successfulChecks.map((check) => checkKey(check.sim_iccid, check.profile_id))
  );

  return phones.map((phone) => {
    const matchingProfiles = profiles
      .filter((profile) => ['sms', 'browser'].includes(profile.method)
        && phone.country === profile.country_code
        && carrierMatchesProfile(phone.carrier, profile.carrier))
      .sort((a, b) => Number(b.enabled || 0) - Number(a.enabled || 0));
    const profile = matchingProfiles.find((candidate) =>
      Number(candidate.enabled) === 1
      || (Number(candidate.discovery_enabled) === 1
        && (allowDiscovery || successful.has(checkKey(phone.iccid, candidate.id))))
    ) || null;

    const serviceType = requiredServiceType(profile);
    let reason = null;
    if (phone.sim_role === 'secondary') reason = 'secondary';
    else if (phone.sim_status !== 'active') reason = 'offline';
    else if (!profile) reason = matchingProfiles.length ? 'unverified' : 'unsupported';
    else if (serviceType && phone.service_type !== serviceType) reason = 'service_type';
    else if (recentBySim.has(phone.iccid)) reason = 'cooldown';

    return {
      phone,
      profile,
      eligible: !reason,
      reason,
      recentCheck: recentBySim.get(phone.iccid) || null,
    };
  });
}

function summarizePlan(plan) {
  const summary = {
    total: plan.length,
    eligible: 0,
    offline: 0,
    unsupported: 0,
    unverified: 0,
    cooldown: 0,
    secondary: 0,
    service_type: 0,
  };
  for (const item of plan) {
    if (item.eligible) summary.eligible += 1;
    else if (item.reason in summary) summary[item.reason] += 1;
  }
  return summary;
}

export function describeBalanceMethod(profile) {
  if (!profile) return { category: 'unsupported', capability: null, interactive: false };
  if (profile.method === 'browser') {
    return { category: 'browser', capability: 'carrier_browser', interactive: true };
  }
  if (profile.method === 'sms' && parseBalanceSkillConfig(profile.skill_config)) {
    return { category: 'sms_ai', capability: 'sms_ai', interactive: false };
  }
  return { category: 'direct_sms', capability: null, interactive: false };
}

function summarizeMethods(plan) {
  const summary = { direct_sms: 0, sms_ai: 0, browser: 0 };
  for (const item of plan.filter((candidate) => candidate.eligible)) {
    const category = describeBalanceMethod(item.profile).category;
    if (category in summary) summary[category] += 1;
  }
  return summary;
}

export function filterBalancePlanByMethods(plan, methods) {
  const selected = new Set(methods);
  return plan.filter((item) => item.eligible
    && selected.has(describeBalanceMethod(item.profile).category));
}

async function loadBalanceQueryPlan(db, {
  phoneIccid = null,
  phoneIccids = null,
  allowDiscovery = false,
} = {}) {
  const scopedIccids = phoneIccid ? [phoneIccid] : phoneIccids;
  const phoneWhere = scopedIccids
    ? `WHERE iccid IN (${scopedIccids.map(() => '?').join(', ')})`
    : '';
  const phoneStatement = db.prepare(`
    SELECT iccid, number, carrier, country, sim_status, sim_index, sim_role, service_type
    FROM device_view ${phoneWhere}
    ORDER BY sim_index
  `);
  const [phoneResult, profileResult, recentResult, successfulResult] = await Promise.all([
    scopedIccids ? phoneStatement.bind(...scopedIccids).all() : phoneStatement.all(),
    db.prepare(`
      SELECT * FROM sim_balance_profiles
      WHERE method IN ('sms', 'browser')
        AND (discovery_enabled = 1 OR enabled = 1)
      ORDER BY enabled DESC, id
    `).all(),
    db.prepare(`
      SELECT sim_iccid, profile_id, id, status, requested_at
      FROM sim_balance_checks
      WHERE ${BALANCE_COOLDOWN_PREDICATE}
      ORDER BY datetime(requested_at) DESC
    `).all(),
    db.prepare(`
      SELECT DISTINCT sim_iccid, profile_id
      FROM sim_balance_checks
      WHERE status = 'parsed'
    `).all(),
  ]);

  return buildBalanceQueryPlan({
    phones: phoneResult.results || [],
    profiles: profileResult.results || [],
    recentChecks: recentResult.results || [],
    successfulChecks: successfulResult.results || [],
    allowDiscovery,
  });
}

async function queueBalanceCheck(db, { phone, profile }, requestedBySubject = null) {
  if (profile.method === 'browser') {
    const { checkId, jobId } = newCarrierWebBalanceIds();
    await db.batch(createCarrierWebBalanceStatements(db, {
      checkId,
      jobId,
      phone,
      profile,
      requestedBySubject,
    }));
    return {
      id: checkId,
      sim_iccid: phone.iccid,
      profile_id: profile.id,
      status: 'queued',
      web_job_id: jobId,
    };
  }

  const checkId = `bal-${nanoid()}`;
  const messageId = `msg-balance-${nanoid()}`;

  await db.batch([
    db.prepare(`
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, status, outbound_message_id, parser_version,
        requested_by_subject
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `).bind(
      checkId,
      phone.iccid,
      profile.id,
      messageId,
      profile.parser_version,
      requestedBySubject,
    ),
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
      phone.iccid,
      phone.number,
      profile.command,
      profile.destination,
      checkId,
    ),
  ]);

  return {
    id: checkId,
    sim_iccid: phone.iccid,
    profile_id: profile.id,
    status: 'queued',
    outbound_message_id: messageId,
  };
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
  if (typeof content !== 'string') return [];

  if (parserVersion === 'cn-telecom-balance-v1') {
    // Prefer 当前号码总余额 (total account balance) over 当前可用余额 (available
    // balance). The SMS reports both; 总余额 includes prepaid amounts and is
    // the canonical figure displayed in the Telecom app.
    // Fall back to 当前号码通用余额 for older SMS formats that omit 总余额.
    const cashMatch = content.match(
      /当前号码总余额(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/
    ) || content.match(
      /(?:当前可用余额|当前号码通用余额)(?:为|是)?[：:\s]*([0-9]+(?:\.[0-9]{1,2})?)\s*元/
    );
    if (!cashMatch) return [];

    return [{
      metric_type: 'cash_balance',
      value: Number(cashMatch[1]),
      unit: null,
      currency: 'CNY',
      expires_at: null,
    }];
  }

  if (parserVersion !== 'cn-mobile-balance-v1') return [];

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

  if (CHINA_UNICOM_NAMES.includes(expected)) {
    return CHINA_UNICOM_NAMES.some((name) => actual.includes(name));
  }

  if (CHINA_TELECOM_NAMES.includes(expected)) {
    return CHINA_TELECOM_NAMES.some((name) => actual.includes(name));
  }

  if (CMHK_NAMES.includes(expected)) {
    return CMHK_NAMES.some((name) => actual.includes(name)) || actual === '移动';
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

export async function findPendingBalanceCheck(db, {
  phone_iccid,
  phone_number,
  message_timestamp = new Date().toISOString(),
}) {
  if (!phone_iccid || !phone_number) return null;

  const result = await db.prepare(`
    SELECT
      c.id,
      c.sim_iccid,
      c.profile_id,
      c.parser_version,
      c.step_index,
      c.status,
      p.expected_senders,
      p.response_window_minutes,
      p.conversation_steps,
      p.skill_config,
      p.destination,
      dv.number AS sim_number,
      datetime('now') <= datetime(COALESCE((
        SELECT MAX(m.timestamp)
        FROM messages m
        WHERE m.balance_check_id = c.id AND m.type = 'sent'
      ), c.sent_at, c.requested_at), '+' || p.response_window_minutes || ' minutes')
        AS response_window_open
    FROM sim_balance_checks c
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
    WHERE c.sim_iccid = ?
      AND c.status IN ('queued', 'awaiting_response', 'failed', 'timed_out')
      AND datetime(?) >= datetime(COALESCE((
        SELECT MAX(m.timestamp)
        FROM messages m
        WHERE m.balance_check_id = c.id AND m.type = 'sent'
      ), c.sent_at, c.requested_at))
      AND datetime(?) <= datetime(COALESCE((
        SELECT MAX(m.timestamp)
        FROM messages m
        WHERE m.balance_check_id = c.id AND m.type = 'sent'
      ), c.sent_at, c.requested_at), '+' || p.response_window_minutes || ' minutes')
    ORDER BY c.requested_at DESC
  `).bind(phone_iccid, message_timestamp, message_timestamp).all();

  const candidates = result.results || [];
  return candidates.find((candidate) =>
    expectedSenderMatches(phone_number, candidate.expected_senders)
  ) || null;
}

export async function linkBalanceReply(
  db,
  check,
  message,
  { allowFollowUp = true } = {},
) {
  if (!check) return;

  const nextStep = matchingNextStep(check, message.content);
  const responseWindowOpen = Number(check.response_window_open ?? 1) === 1;
  if (nextStep && allowFollowUp && responseWindowOpen) {
    return queueBalanceFollowUp(
      db,
      check,
      message,
      nextStep,
      check.status || 'awaiting_response',
    );
  }

  const metrics = parseBalanceMetrics(check.parser_version, message.content);
  const statements = [db.prepare(`
    UPDATE sim_balance_checks
    SET status = ?,
        completed_at = CURRENT_TIMESTAMP,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN ('queued', 'awaiting_response', 'failed', 'timed_out')
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

  const skill = parseBalanceSkillConfig(check.skill_config);
  if (!metrics.length && skill && allowFollowUp && responseWindowOpen
    && Number(check.step_index || 0) < skill.max_turns) {
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO sim_balance_skill_jobs (
        id, check_id, response_message_id, step_index
      )
      SELECT ?, id, ?, step_index
      FROM sim_balance_checks
      WHERE id = ?
        AND status = 'response_received'
        AND response_message_id = ?
    `).bind(
      `skill-${nanoid()}`,
      message.id,
      check.id,
      message.id,
    ));
  }

  statements.push(db.prepare(`
    UPDATE messages
    SET purpose = 'balance_maintenance',
        balance_check_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND (balance_check_id IS NULL OR balance_check_id = ?)
      AND EXISTS (
        SELECT 1
        FROM sim_balance_checks c
        WHERE c.id = ?
          AND c.response_message_id = messages.id
      )
  `).bind(check.id, message.id, check.id, check.id));

  const results = await db.batch(statements);
  return {
    linked: Number(results?.[0]?.meta?.changes ?? 1) > 0,
    results,
  };
}

export async function expireStaleBalanceChecks(db) {
  const results = await db.batch([
    db.prepare(`
      UPDATE sim_balance_checks
      SET status = 'timed_out',
          completed_at = CURRENT_TIMESTAMP,
          error = 'No reply received within the configured response window',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'awaiting_response'
        AND EXISTS (
          SELECT 1
          FROM sim_balance_profiles p
          WHERE p.id = sim_balance_checks.profile_id
            AND datetime(COALESCE((
              SELECT MAX(m.timestamp)
              FROM messages m
              WHERE m.balance_check_id = sim_balance_checks.id
                AND m.type = 'sent'
            ), sim_balance_checks.sent_at, sim_balance_checks.requested_at),
              '+' || p.response_window_minutes || ' minutes') < datetime('now')
        )
    `).bind(),
    db.prepare(`
      UPDATE sim_balance_skill_jobs
      SET status = 'stopped',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Balance response window expired'),
          updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'leased')
        AND EXISTS (
          SELECT 1
          FROM sim_balance_checks c
          WHERE c.id = sim_balance_skill_jobs.check_id
            AND c.status = 'timed_out'
        )
    `).bind(),
  ]);

  return {
    expired: Number(results?.[0]?.meta?.changes || 0),
    stopped_jobs: Number(results?.[1]?.meta?.changes || 0),
  };
}

export async function queueBalanceFollowUp(
  db,
  check,
  message,
  step,
  fromStatus,
  extraStatements = [],
) {
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
    ...extraStatements,
  ]);

  const queued = Number(results?.[0]?.meta?.changes ?? 1) > 0;
  return { queued, message_id: queued ? messageId : null };
}

export async function updateBalanceCheckForSmsResult(
  db,
  messageId,
  outcome,
  errorMessage = null,
) {
  const submitted = outcome === 'confirmed' || outcome === 'submitted_unconfirmed';
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
    submitted ? 'awaiting_response' : 'failed',
    submitted ? 1 : 0,
    submitted ? 1 : 0,
    submitted ? null : (errorMessage || 'SMS send failed'),
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
        p.skill_config,
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
        (
          SELECT sj.status
          FROM sim_balance_skill_jobs sj
          WHERE sj.check_id = c.id
          ORDER BY datetime(sj.created_at) DESC, sj.rowid DESC
          LIMIT 1
        ) AS skill_job_status,
        (
          SELECT wj.status
          FROM sim_balance_web_jobs wj
          WHERE wj.check_id = c.id
          LIMIT 1
        ) AS web_job_status,
        (
          SELECT wj.human_reason
          FROM sim_balance_web_jobs wj
          WHERE wj.check_id = c.id
          LIMIT 1
        ) AS web_human_reason,
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
      let profileOutputs = [];
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
      try {
        const skill = JSON.parse(check.skill_config || '{}');
        profileOutputs = Array.isArray(skill.outputs)
          ? skill.outputs.filter((output) => typeof output === 'string')
          : [];
      } catch {
        profileOutputs = [];
      }
      const {
        metrics_json: _metricsJson,
        conversation_json: _conversationJson,
        skill_config: _skillConfig,
        ...record
      } = check;
      let displayStatus = record.status;
      if (['response_received', 'unparsed'].includes(record.status)
        && ['pending', 'leased'].includes(record.skill_job_status)) {
        displayStatus = record.skill_job_status === 'leased' ? 'skill_processing' : 'skill_pending';
      } else if (record.status === 'queued' && record.web_job_status) {
        const webStatuses = {
          pending: 'web_pending',
          leased: 'web_processing',
          awaiting_otp: 'web_otp',
          authenticating: 'web_authenticating',
          querying: 'web_querying',
          human_verification_required: 'web_human_required',
        };
        displayStatus = webStatuses[record.web_job_status] || record.status;
      }
      return {
        ...record,
        display_status: displayStatus,
        profile_outputs: profileOutputs,
        metrics,
        conversation,
      };
    });

    return json({ success: true, data: checks });
  },

  async preview(request) {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    let phoneIccids = null;
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, error: 'Invalid JSON body' }, 400);
      }
      phoneIccids = parseBatchScope(body?.phone_iccids);
      if (!phoneIccids) {
        return json({ success: false, error: 'A unique non-empty SIM scope is required' }, 400);
      }
    }
    const [plan, runners] = await Promise.all([
      loadBalanceQueryPlan(request.env.DB, { phoneIccids }),
      loadBalanceRunnerStatus(request.env.DB, { authSubject: requestedBySubject }),
    ]);
    return json({
      success: true,
      summary: summarizePlan(plan),
      method_summary: summarizeMethods(plan),
      runner_capabilities: runners.capabilities,
      eligible: plan
        .filter((item) => item.eligible)
        .map((item) => ({
          phone_iccid: item.phone.iccid,
          sim_index: item.phone.sim_index,
          phone_number: item.phone.number,
          carrier: item.phone.carrier,
          profile_id: item.profile.id,
          ...describeBalanceMethod(item.profile),
        })),
    });
  },

  async preflight(request) {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    const phoneIccid = new URL(request.url).searchParams.get('phone_iccid')?.trim();
    if (!phoneIccid) return json({ success: false, error: 'phone_iccid is required' }, 400);

    const [[item], runners] = await Promise.all([
      loadBalanceQueryPlan(request.env.DB, { phoneIccid, allowDiscovery: true }),
      loadBalanceRunnerStatus(request.env.DB, { authSubject: requestedBySubject }),
    ]);
    if (!item) return json({ success: false, error: 'SIM not found' }, 404);

    const method = describeBalanceMethod(item.profile);
    const runner = method.capability ? runners.capabilities[method.capability] : null;
    return json({
      success: true,
      eligible: item.eligible,
      reason: item.reason,
      phone: {
        iccid: item.phone.iccid,
        sim_index: item.phone.sim_index,
        number: item.phone.number,
        carrier: item.phone.carrier,
      },
      profile: item.profile ? {
        id: item.profile.id,
        method: item.profile.method,
        carrier: item.profile.carrier,
      } : null,
      method,
      runner: runner ? {
        required: true,
        ...runner,
      } : { required: false, available: true, state: 'not_required' },
    });
  },

  async query(request) {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    if (typeof body?.phone_iccid !== 'string') {
      return json({ success: false, error: 'phone_iccid is required' }, 400);
    }

    const [item] = await loadBalanceQueryPlan(request.env.DB, {
      phoneIccid: body.phone_iccid,
      allowDiscovery: true,
    });
    if (!item) return json({ success: false, error: 'SIM not found' }, 404);
    if (!item.eligible) {
      const errors = {
        offline: 'SIM is not active',
        unsupported: 'No balance query profile matches this SIM',
        unverified: 'Balance query profile is not verified for this SIM',
        cooldown: 'This SIM has already been queried in the last 24 hours',
      };
      return json({
        success: false,
        error: errors[item.reason] || 'SIM is not eligible for a balance query',
        reason: item.reason,
        previous_check: item.recentCheck,
      }, item.reason === 'cooldown' ? 429 : 409);
    }

    const check = await queueBalanceCheck(request.env.DB, item, requestedBySubject);
    return json({ success: true, check }, 202);
  },

  async queryBatch(request) {
    const requestedBySubject = request.user?.id;
    if (!requestedBySubject) return json({ error: 'Unauthorized' }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: 'Invalid JSON body' }, 400);
    }
    const methods = body?.methods;
    if (!Array.isArray(methods) || methods.length < 1
      || methods.length > BATCH_METHODS.size
      || new Set(methods).size !== methods.length
      || methods.some((method) => !BATCH_METHODS.has(method))) {
      return json({ success: false, error: 'A unique list of supported methods is required' }, 400);
    }

    const phoneIccids = parseBatchScope(body?.phone_iccids);
    if (!phoneIccids) {
      return json({ success: false, error: 'A unique non-empty SIM scope is required' }, 400);
    }

    const plan = await loadBalanceQueryPlan(request.env.DB, { phoneIccids });
    const eligible = filterBalancePlanByMethods(plan, methods);
    const checks = [];
    const failures = [];

    // Queue on the server, one audited transaction per SIM. The daemon fetch endpoint
    // applies a separate maintenance-message cap, so a fleet action cannot monopolise
    // normal user SMS delivery.
    for (const item of eligible) {
      try {
        checks.push(await queueBalanceCheck(request.env.DB, item, requestedBySubject));
      } catch (error) {
        failures.push({
          phone_iccid: item.phone.iccid,
          sim_index: item.phone.sim_index,
          error: error?.message || 'Failed to queue balance query',
        });
      }
    }

    return json({
      success: true,
      batch_id: `balance-batch-${nanoid()}`,
      summary: {
        ...summarizePlan(plan),
        selected: eligible.length,
        methods,
        queued: checks.length,
        failed_to_queue: failures.length,
      },
      checks,
      failures,
    }, 202);
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
          AND (${BALANCE_COOLDOWN_PREDICATE})
        ORDER BY requested_at DESC LIMIT 1
      `).bind(phone_iccid).first(),
    ]);

    if (!profile) {
      return json({ success: false, error: 'Balance profile is not enabled' }, 404);
    }
    if (!['sms', 'browser'].includes(profile.method)) {
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

    const check = await queueBalanceCheck(db, { phone, profile });

    return json({
      success: true,
      check,
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
        SET status = 'sending', error_message = NULL,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
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

  async stop(request) {
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
      SELECT id, status FROM sim_balance_checks WHERE id = ?
    `).bind(body.check_id).first();
    if (!check) return json({ success: false, error: 'Balance check not found' }, 404);
    if (!['awaiting_response', 'response_received'].includes(check.status)) {
      return json({ success: false, error: 'Balance check is not stoppable' }, 409);
    }

    const finalStatus = check.status === 'awaiting_response' ? 'timed_out' : 'unparsed';
    const results = await request.env.DB.batch([
      request.env.DB.prepare(`
        UPDATE sim_balance_checks
        SET status = ?, completed_at = CURRENT_TIMESTAMP,
            error = CASE WHEN ? = 'timed_out' THEN 'Stopped by operator' ELSE error END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?
      `).bind(finalStatus, finalStatus, check.id, check.status),
      request.env.DB.prepare(`
        UPDATE sim_balance_skill_jobs
        SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Stopped by operator'),
            updated_at = CURRENT_TIMESTAMP
        WHERE check_id = ? AND status IN ('pending', 'leased')
      `).bind(check.id),
    ]);

    if (Number(results?.[0]?.meta?.changes ?? 1) === 0) {
      return json({ success: false, error: 'Balance check changed before stop' }, 409);
    }

    return json({ success: true, check: { id: check.id, status: finalStatus } });
  },
};
