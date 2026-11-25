import * as v from 'valibot';
import {
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
} from '../../shared/balance-status.js';
import {
  BalanceConversationMessage,
  BalanceWebEvent,
  PROFILE_METHODS,
} from '../../shared/api/balance-checks.js';
import type { BalanceProfile } from './balance-plan.js';

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

/** A batch statement that changed no row lost a race with another writer. */
export function changed(result: D1RunResult | undefined): boolean {
  return result !== undefined && result.meta.changes > 0;
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
