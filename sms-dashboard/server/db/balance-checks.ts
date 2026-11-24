import * as v from 'valibot';
import {
  D1_MAX_BOUND_PARAMETERS,
  queryAll,
  queryFirst,
  type D1,
  type D1Batch,
  type D1RunResult,
  type D1Statement,
} from '../lib/d1.js';
import {
  CHECK_STATUSES,
  SKILL_JOB_STATUSES,
  WEB_JOB_STATUSES,
  type CheckStatus,
} from '../../shared/balance-status.js';
import {
  BalanceConversationMessage,
  BalanceWebEvent,
  PROFILE_METHODS,
  QUERY_METHODS,
  RecentBalanceCheck,
  type BalanceMetric,
} from '../../shared/api/balance-checks.js';

const Flag = v.picklist([0, 1]);

const PlanPhoneRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  country: v.nullable(v.string()),
  sim_status: v.string(),
  sim_index: v.number(),
  sim_role: v.string(),
  service_type: v.string(),
});

export type PlanPhone = v.InferOutput<typeof PlanPhoneRow>;

const PROFILE_COLUMNS = `id, country_code, carrier, method, command, destination, expected_senders,
  parser_version, response_window_minutes, discovery_enabled, enabled, conversation_steps,
  skill_config`;

const profileColumns = {
  id: v.string(),
  country_code: v.string(),
  carrier: v.string(),
  command: v.string(),
  destination: v.nullable(v.string()),
  expected_senders: v.string(),
  parser_version: v.string(),
  response_window_minutes: v.number(),
  discovery_enabled: Flag,
  enabled: Flag,
  conversation_steps: v.string(),
  skill_config: v.string(),
};

const ProfileRow = v.object({ ...profileColumns, method: v.picklist(PROFILE_METHODS) });

const QueryProfileRow = v.object({ ...profileColumns, method: v.picklist(QUERY_METHODS) });

export type BalanceProfile = v.InferOutput<typeof QueryProfileRow>;

const ParsedCheckRow = v.object({ sim_iccid: v.string(), profile_id: v.string() });

export type ParsedCheck = v.InferOutput<typeof ParsedCheckRow>;

const BALANCE_COOLDOWN_PREDICATE = `
  status IN ('queued', 'awaiting_response')
  OR (status IN ('response_received', 'parsed', 'unparsed')
    AND datetime(requested_at) >= datetime('now', '-24 hours'))
`;

const PendingCheckRow = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  parser_version: v.string(),
  step_index: v.number(),
  status: v.picklist(CHECK_STATUSES),
  expected_senders: v.string(),
  conversation_steps: v.string(),
  skill_config: v.string(),
  destination: v.nullable(v.string()),
  sim_number: v.nullable(v.string()),
  response_window_open: Flag,
});

export type BalanceCheckRow = v.InferOutput<typeof PendingCheckRow>;

const CheckStatusSchema = v.picklist(CHECK_STATUSES);
const SkillJobStatusSchema = v.nullable(v.picklist(SKILL_JOB_STATUSES));
const WebJobStatusSchema = v.nullable(v.picklist(WEB_JOB_STATUSES));

const ListRow = v.object({
  id: v.string(),
  sim_iccid: v.string(),
  profile_id: v.string(),
  requested_at: v.string(),
  sent_at: v.nullable(v.string()),
  completed_at: v.nullable(v.string()),
  status: CheckStatusSchema,
  step_index: v.number(),
  response_sender: v.nullable(v.string()),
  raw_response: v.nullable(v.string()),
  error: v.nullable(v.string()),
  parser_version: v.string(),
  country_code: v.string(),
  profile_carrier: v.string(),
  method: v.picklist(PROFILE_METHODS),
  command: v.string(),
  destination: v.nullable(v.string()),
  conversation_steps: v.string(),
  skill_config: v.string(),
  sim_index: v.nullable(v.number()),
  sim_number: v.nullable(v.string()),
  sim_carrier: v.nullable(v.string()),
  sim_country: v.nullable(v.string()),
  outbound_content: v.nullable(v.string()),
  outbound_recipient: v.nullable(v.string()),
  outbound_timestamp: v.nullable(v.string()),
  outbound_status: v.nullable(v.string()),
  response_content: v.nullable(v.string()),
  response_phone_number: v.nullable(v.string()),
  response_timestamp: v.nullable(v.string()),
  skill_job_status: SkillJobStatusSchema,
  web_job_status: WebJobStatusSchema,
  web_human_reason: v.nullable(v.string()),
  metrics_json: v.string(),
});

export type BalanceCheckListRow = v.InferOutput<typeof ListRow>;

const StatusRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  updated_at: v.string(),
  completed_at: v.nullable(v.string()),
  skill_job_status: SkillJobStatusSchema,
  web_job_status: WebJobStatusSchema,
  web_human_reason: v.nullable(v.string()),
});

const IdRow = v.object({ id: v.string() });

const CheckPhoneRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  country: v.nullable(v.string()),
  sim_status: v.string(),
});

const CooldownRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  requested_at: v.string(),
});

const ContinueRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  step_index: v.number(),
  response_message_id: v.nullable(v.string()),
  response_sender: v.nullable(v.string()),
  raw_response: v.nullable(v.string()),
  destination: v.nullable(v.string()),
  conversation_steps: v.string(),
  sim_number: v.nullable(v.string()),
});

const RetryRow = v.object({
  id: v.string(),
  status: CheckStatusSchema,
  step_index: v.number(),
  destination: v.nullable(v.string()),
  conversation_steps: v.string(),
  message_id: v.string(),
  message_content: v.string(),
  message_recipient: v.nullable(v.string()),
  message_status: v.nullable(v.string()),
});

const StopRow = v.object({ id: v.string(), status: CheckStatusSchema });

export interface BalanceMessage {
  id: string;
  phone_number: string | null;
  content: string;
}

export interface FollowUpCheck {
  id: string;
  sim_number: string | null;
  destination: string | null;
  step_index: number;
}

/** A batch statement that changed no row lost a race with another writer. */
function changed(result: D1RunResult | undefined): boolean {
  return result !== undefined && result.meta.changes > 0;
}

// A scope larger than D1's bind limit is read in chunks.
export async function listPlanPhones(
  db: D1<'all'>,
  scope: readonly string[] | null,
): Promise<PlanPhone[]> {
  const select = `
    SELECT iccid, number, carrier, country, sim_status, sim_index, sim_role, service_type
    FROM device_view`;
  if (scope === null) {
    return queryAll(db.prepare(`${select} ORDER BY sim_index`), PlanPhoneRow);
  }
  const phones: PlanPhone[] = [];
  for (let start = 0; start < scope.length; start += D1_MAX_BOUND_PARAMETERS) {
    const chunk = scope.slice(start, start + D1_MAX_BOUND_PARAMETERS);
    const where = `WHERE iccid IN (${chunk.map(() => '?').join(', ')})`;
    phones.push(...(await queryAll(db.prepare(`${select} ${where}`).bind(...chunk), PlanPhoneRow)));
  }
  return phones.sort((a, b) => a.sim_index - b.sim_index);
}

export function listQueryProfiles(db: D1<'all'>): Promise<BalanceProfile[]> {
  return queryAll(
    db.prepare(
      `
      SELECT ${PROFILE_COLUMNS} FROM sim_balance_profiles
      WHERE method IN ('sms', 'browser')
        AND (discovery_enabled = 1 OR enabled = 1)
      ORDER BY enabled DESC, id
    `,
    ),
    QueryProfileRow,
  );
}

export function listCooldownChecks(db: D1<'all'>): Promise<RecentBalanceCheck[]> {
  return queryAll(
    db.prepare(
      `
      SELECT sim_iccid, profile_id, id, status, requested_at
      FROM sim_balance_checks
      WHERE ${BALANCE_COOLDOWN_PREDICATE}
      ORDER BY datetime(requested_at) DESC
    `,
    ),
    RecentBalanceCheck,
  );
}

export function listParsedChecks(db: D1<'all'>): Promise<ParsedCheck[]> {
  return queryAll(
    db.prepare(
      `
      SELECT DISTINCT sim_iccid, profile_id
      FROM sim_balance_checks
      WHERE status = 'parsed'
    `,
    ),
    ParsedCheckRow,
  );
}

export async function queueSmsBalanceCheck(
  db: D1<'run'> & D1Batch<'run'>,
  {
    checkId,
    messageId,
    phone,
    profile,
    requestedBySubject,
  }: {
    checkId: string;
    messageId: string;
    phone: { iccid: string; number: string };
    profile: Pick<BalanceProfile, 'id' | 'parser_version' | 'command' | 'destination'>;
    requestedBySubject: string | null;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `
      INSERT INTO sim_balance_checks (
        id, sim_iccid, profile_id, status, outbound_message_id, parser_version,
        requested_by_subject
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `,
      )
      .bind(
        checkId,
        phone.iccid,
        profile.id,
        messageId,
        profile.parser_version,
        requestedBySubject,
      ),
    db
      .prepare(
        `
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      ) VALUES (
        ?, ?, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
        'sending', 'filtered', 'balance_maintenance', ?
      )
    `,
      )
      .bind(messageId, phone.iccid, phone.number, profile.command, profile.destination, checkId),
  ]);
}

export async function runBalanceStatements(
  db: D1Batch<'run'>,
  statements: D1Statement<'run'>[],
): Promise<void> {
  await db.batch(statements);
}

export function listPendingChecksForReply(
  db: D1<'all'>,
  { phone_iccid, message_timestamp }: { phone_iccid: string; message_timestamp: string },
): Promise<BalanceCheckRow[]> {
  return queryAll(
    db
      .prepare(
        `
    SELECT
      c.id,
      c.sim_iccid,
      c.profile_id,
      c.parser_version,
      c.step_index,
      c.status,
      p.expected_senders,
      p.conversation_steps,
      p.skill_config,
      p.destination,
      dv.number AS sim_number,
      datetime('now') <= datetime(c.deadline_at)
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
      AND datetime(?) <= datetime(c.deadline_at)
    ORDER BY c.requested_at DESC
  `,
      )
      .bind(phone_iccid, message_timestamp, message_timestamp),
    PendingCheckRow,
  );
}

export async function recordBalanceReply(
  db: D1<'run'> & D1Batch<'run'>,
  {
    check,
    message,
    content,
    metrics,
    skillJobId,
  }: {
    check: Pick<BalanceCheckRow, 'id'>;
    message: BalanceMessage;
    content: string;
    metrics: readonly BalanceMetric[];
    skillJobId: string | null;
  },
): Promise<boolean> {
  const statements: D1Statement<'run'>[] = [
    db
      .prepare(
        `
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
  `,
      )
      .bind(
        metrics.length ? 'parsed' : 'response_received',
        message.id,
        message.phone_number,
        content,
        check.id,
      ),
  ];

  for (const metric of metrics) {
    statements.push(
      db
        .prepare(
          `
      INSERT INTO sim_balance_metrics (
        check_id, metric_type, value, unit, currency, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(check_id, metric_type) DO UPDATE SET
        value = excluded.value,
        unit = excluded.unit,
        currency = excluded.currency,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `,
        )
        .bind(
          check.id,
          metric.metric_type,
          metric.value,
          metric.unit,
          metric.currency,
          metric.expires_at,
        ),
    );
  }

  if (skillJobId !== null) {
    statements.push(
      db
        .prepare(
          `
      INSERT OR IGNORE INTO sim_balance_skill_jobs (
        id, check_id, response_message_id, step_index
      )
      SELECT ?, id, ?, step_index
      FROM sim_balance_checks
      WHERE id = ?
        AND status = 'response_received'
        AND response_message_id = ?
    `,
        )
        .bind(skillJobId, message.id, check.id, message.id),
    );
  }

  statements.push(
    db
      .prepare(
        `
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
  `,
      )
      .bind(check.id, message.id, check.id, check.id),
  );

  const [update] = await db.batch(statements);
  return changed(update);
}

export async function expireStaleBalanceChecks(
  db: D1<'run'> & D1Batch<'run'>,
): Promise<{ expired: number; stopped_jobs: number }> {
  const [checks, jobs] = await db.batch([
    db.prepare(
      `
      UPDATE sim_balance_checks
      SET status = 'timed_out',
          completed_at = CURRENT_TIMESTAMP,
          error = 'No reply received within the configured response window',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'awaiting_response'
        AND deadline_at < CURRENT_TIMESTAMP
    `,
    ),
    db.prepare(
      `
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
    `,
    ),
  ]);

  return {
    expired: checks?.meta.changes ?? 0,
    stopped_jobs: jobs?.meta.changes ?? 0,
  };
}

export async function queueBalanceFollowUpMessage(
  db: D1<'run'> & D1Batch<'run'>,
  {
    messageId,
    check,
    message,
    step,
    fromStatus,
    extraStatements,
  }: {
    messageId: string;
    check: FollowUpCheck;
    message: BalanceMessage;
    step: { command: string };
    fromStatus: CheckStatus;
    extraStatements: readonly D1Statement<'run'>[];
  },
): Promise<boolean> {
  const [insert] = await db.batch([
    db
      .prepare(
        `
      INSERT INTO messages (
        id, phone_iccid, phone_number, content, timestamp, type, recipient,
        status, filter_status, purpose, balance_check_id
      )
      SELECT ?, c.sim_iccid, ?, ?, CURRENT_TIMESTAMP, 'sent', ?,
        'sending', 'filtered', 'balance_maintenance', c.id
      FROM sim_balance_checks c
      WHERE c.id = ? AND c.status = ? AND c.step_index = ?
    `,
      )
      .bind(
        messageId,
        check.sim_number,
        step.command,
        check.destination,
        check.id,
        fromStatus,
        check.step_index,
      ),
    db
      .prepare(
        `
    UPDATE sim_balance_checks
    SET status = 'queued',
        step_index = step_index + 1,
        completed_at = NULL,
        response_message_id = ?,
        response_sender = ?,
        raw_response = ?,
        deadline_at = NULL,
        error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = ?
      AND step_index = ?
    `,
      )
      .bind(
        message.id,
        message.phone_number,
        message.content,
        check.id,
        fromStatus,
        check.step_index,
      ),
    ...extraStatements,
  ]);
  return changed(insert);
}

export async function markBalanceCheckSmsResult(
  db: D1<'run'>,
  messageId: string,
  { submitted, failure }: { submitted: boolean; failure: string },
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE sim_balance_checks
    SET status = ?,
        sent_at = CASE WHEN ? THEN COALESCE(sent_at, CURRENT_TIMESTAMP) ELSE sent_at END,
        deadline_at = CASE WHEN ? THEN datetime(
          CURRENT_TIMESTAMP,
          '+' || (SELECT p.response_window_minutes
                  FROM sim_balance_profiles p
                  WHERE p.id = sim_balance_checks.profile_id) || ' minutes'
        ) ELSE deadline_at END,
        completed_at = CASE WHEN ? THEN completed_at ELSE CURRENT_TIMESTAMP END,
        error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT balance_check_id FROM messages WHERE id = ?
    )
      AND status = 'queued'
  `,
    )
    .bind(
      submitted ? 'awaiting_response' : 'failed',
      submitted ? 1 : 0,
      submitted ? 1 : 0,
      submitted ? 1 : 0,
      submitted ? null : failure,
      messageId,
    )
    .run();
}

async function listBalanceCheckRows(
  db: D1<'all'>,
  { where, params, limit }: { where: string; params: string[]; limit: number },
) {
  return queryAll(
    db
      .prepare(
        `
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
          ORDER BY sj.created_at DESC, sj.rowid DESC
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
      ORDER BY c.requested_at DESC
      LIMIT ?
    `,
      )
      .bind(...params, limit),
    ListRow,
  );
}

export function listBalanceChecks(
  db: D1<'all'>,
  { phoneIccid, limit }: { phoneIccid: string | undefined; limit: number },
) {
  const conditions: string[] = [];
  const params: string[] = [];

  if (phoneIccid) {
    conditions.push('c.sim_iccid = ?');
    params.push(phoneIccid);
  }

  return listBalanceCheckRows(db, {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    limit,
  });
}

export function listBalanceChecksByIds(db: D1<'all'>, ids: readonly string[]) {
  return listBalanceCheckRows(db, {
    where: `WHERE c.id IN (${ids.map(() => '?').join(', ')})`,
    params: [...ids],
    limit: ids.length,
  });
}

export function listBalanceCheckStatuses(db: D1<'all'>, ids: readonly string[]) {
  const placeholders = ids.map(() => '?').join(', ');
  return queryAll(
    db
      .prepare(
        `
      SELECT c.id, c.status, c.updated_at, c.completed_at,
        (SELECT sj.status FROM sim_balance_skill_jobs sj
         WHERE sj.check_id = c.id ORDER BY sj.created_at DESC, sj.rowid DESC LIMIT 1)
          AS skill_job_status,
        wj.status AS web_job_status,
        wj.human_reason AS web_human_reason
      FROM sim_balance_checks c
      LEFT JOIN sim_balance_web_jobs wj ON wj.check_id = c.id
      WHERE c.id IN (${placeholders})
    `,
      )
      .bind(...ids),
    StatusRow,
  );
}

export function findBalanceCheckId(db: D1<'first'>, id: string) {
  return queryFirst(
    db
      .prepare(
        `
      SELECT id FROM sim_balance_checks WHERE id = ?
    `,
      )
      .bind(id),
    IdRow,
  );
}

export function listBalanceCheckMessages(db: D1<'all'>, checkId: string) {
  return queryAll(
    db
      .prepare(
        `
        SELECT id, type, content, timestamp, status, phone_number, recipient
        FROM messages
        WHERE balance_check_id = ?
        ORDER BY timestamp, id
      `,
      )
      .bind(checkId),
    BalanceConversationMessage,
  );
}

export function listBalanceCheckWebEvents(db: D1<'all'>, checkId: string) {
  return queryAll(
    db
      .prepare(
        `
        SELECT e.id, e.event_type, e.detail_json, e.created_at
        FROM sim_balance_web_events e
        JOIN sim_balance_web_jobs j ON j.id = e.job_id
        WHERE j.check_id = ?
        ORDER BY e.created_at, e.id
      `,
      )
      .bind(checkId),
    BalanceWebEvent,
  );
}

export function findEnabledBalanceProfile(db: D1<'first'>, profileId: string) {
  return queryFirst(
    db
      .prepare(
        `
        SELECT ${PROFILE_COLUMNS} FROM sim_balance_profiles
        WHERE id = ? AND (discovery_enabled = 1 OR enabled = 1)
      `,
      )
      .bind(profileId),
    ProfileRow,
  );
}

export function findCheckPhone(db: D1<'first'>, iccid: string) {
  return queryFirst(
    db
      .prepare(
        `
        SELECT iccid, number, carrier, country, sim_status
        FROM device_view WHERE iccid = ?
      `,
      )
      .bind(iccid),
    CheckPhoneRow,
  );
}

export function findRecentBalanceCheck(db: D1<'first'>, iccid: string) {
  return queryFirst(
    db
      .prepare(
        `
        SELECT id, status, requested_at
        FROM sim_balance_checks
        WHERE sim_iccid = ?
          AND (${BALANCE_COOLDOWN_PREDICATE})
        ORDER BY requested_at DESC LIMIT 1
      `,
      )
      .bind(iccid),
    CooldownRow,
  );
}

export function findBalanceCheckToContinue(db: D1<'first'>, checkId: string) {
  return queryFirst(
    db
      .prepare(
        `
      SELECT
        c.id, c.status, c.step_index, c.response_message_id,
        c.response_sender, c.raw_response,
        p.destination, p.conversation_steps,
        dv.number AS sim_number
      FROM sim_balance_checks c
      JOIN sim_balance_profiles p ON p.id = c.profile_id
      LEFT JOIN device_view dv ON dv.iccid = c.sim_iccid
      WHERE c.id = ?
    `,
      )
      .bind(checkId),
    ContinueRow,
  );
}

export function findBalanceCheckToRetry(db: D1<'first'>, checkId: string) {
  return queryFirst(
    db
      .prepare(
        `
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
    `,
      )
      .bind(checkId),
    RetryRow,
  );
}

export async function requeueBalanceCheck(
  db: D1Batch<'run'> & D1<'run'>,
  check: { id: string; step_index: number; message_id: string },
): Promise<boolean> {
  const [message, requeued] = await db.batch([
    db
      .prepare(
        `
        UPDATE messages
        SET status = 'sending', error_message = NULL,
            processing_session_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed'
          AND purpose = 'balance_maintenance'
      `,
      )
      .bind(check.message_id),
    db
      .prepare(
        `
        UPDATE sim_balance_checks
        SET status = 'queued', completed_at = NULL, deadline_at = NULL, error = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed' AND step_index = ?
      `,
      )
      .bind(check.id, check.step_index),
  ]);
  return changed(message) && changed(requeued);
}

export function findBalanceCheckToStop(db: D1<'first'>, checkId: string) {
  return queryFirst(
    db
      .prepare(
        `
      SELECT id, status FROM sim_balance_checks WHERE id = ?
    `,
      )
      .bind(checkId),
    StopRow,
  );
}

export async function stopBalanceCheck(
  db: D1Batch<'run'> & D1<'run'>,
  check: { id: string; status: CheckStatus },
  finalStatus: 'timed_out' | 'unparsed',
): Promise<boolean> {
  const [stopped] = await db.batch([
    db
      .prepare(
        `
        UPDATE sim_balance_checks
        SET status = ?, completed_at = CURRENT_TIMESTAMP,
            error = CASE WHEN ? = 'timed_out' THEN 'Stopped by operator' ELSE error END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?
      `,
      )
      .bind(finalStatus, finalStatus, check.id, check.status),
    db
      .prepare(
        `
        UPDATE sim_balance_skill_jobs
        SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'Stopped by operator'),
            updated_at = CURRENT_TIMESTAMP
        WHERE check_id = ? AND status IN ('pending', 'leased')
      `,
      )
      .bind(check.id),
  ]);
  return changed(stopped);
}
