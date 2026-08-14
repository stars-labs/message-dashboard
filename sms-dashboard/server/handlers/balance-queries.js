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
      c.profile_id,
      c.parser_version,
      p.expected_senders,
      p.response_window_minutes
    FROM sim_balance_checks c
    JOIN sim_balance_profiles p ON p.id = c.profile_id
    WHERE c.sim_iccid = ?
      AND c.status = ?
      AND datetime(c.requested_at) >= datetime(
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

  await db.prepare(`
    UPDATE sim_balance_checks
    SET status = 'response_received',
        completed_at = CURRENT_TIMESTAMP,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'awaiting_response'
  `).bind(message.id, message.phone_number, message.content, check.id).run();
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
        sent_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sent_at END,
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
};
