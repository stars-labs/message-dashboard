import * as v from 'valibot';
import { D1_MAX_BOUND_PARAMETERS, queryAll, queryFirst, type D1 } from '../lib/d1.js';
import { CHECK_STATUSES } from '../../shared/balance-status.js';
import {
  PROFILE_METHODS,
  QUERY_METHODS,
  RecentBalanceCheck,
} from '../../shared/api/balance-checks.js';

export const Flag = v.picklist([0, 1]);

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

const CheckPhoneRow = v.object({
  iccid: v.string(),
  number: v.string(),
  carrier: v.nullable(v.string()),
  country: v.nullable(v.string()),
  sim_status: v.string(),
});

const CooldownRow = v.object({
  id: v.string(),
  status: v.picklist(CHECK_STATUSES),
  requested_at: v.string(),
});

// A scope larger than D1's bind limit is read in chunks.
export async function listPlanPhones(
  db: D1<'all'>,
  scope: readonly string[],
): Promise<PlanPhone[]> {
  const select = `
    SELECT iccid, number, carrier, country, sim_status, sim_index, sim_role, service_type
    FROM device_view`;
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
