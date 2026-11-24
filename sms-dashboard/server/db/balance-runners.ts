import * as v from 'valibot';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';
import {
  BalanceRunner,
  BalanceRunnerCapability,
  type RunnerHeartbeatBody,
} from '../../shared/api/balance-runners.js';
import type { AuthorizedRunner } from '../utils/runner-auth.js';

const AUTH_MODES = ['legacy_api_key', 'auth0_device'] as const;

const ExistingInstallationRow = v.object({
  auth_mode: v.picklist(AUTH_MODES),
  auth_subject: v.nullable(v.string()),
  revoked_at: v.nullable(v.string()),
});

/** An installation owned by a dashboard user; the status query reads device installations only. */
const InstallationRow = v.omit(BalanceRunner, ['online', 'capabilities']);

export function listUserRunnerInstallations(db: D1<'all'>, authSubject: string) {
  return queryAll(
    db
      .prepare(
        `
      SELECT id, display_name, auth_mode, platform, version, last_heartbeat,
        CAST((julianday('now') - julianday(last_heartbeat)) * 86400 AS INTEGER)
          AS seconds_since_heartbeat
      FROM balance_runner_installations
      WHERE revoked_at IS NULL AND auth_mode = 'auth0_device' AND auth_subject = ?
      ORDER BY datetime(last_heartbeat) DESC, id
    `,
      )
      .bind(authSubject),
    InstallationRow,
  );
}

export function listUserRunnerCapabilities(db: D1<'all'>, authSubject: string) {
  return queryAll(
    db
      .prepare(
        `
      SELECT c.runner_id, c.capability, c.state, c.current_job_id, c.concurrency,
        c.detail_code, r.last_heartbeat,
        CAST((julianday('now') - julianday(r.last_heartbeat)) * 86400 AS INTEGER)
          AS seconds_since_heartbeat
      FROM balance_runner_capabilities c
      JOIN balance_runner_installations r ON r.id = c.runner_id
      WHERE r.revoked_at IS NULL AND r.auth_mode = 'auth0_device' AND r.auth_subject = ?
      ORDER BY datetime(r.last_heartbeat) DESC, c.runner_id
    `,
      )
      .bind(authSubject),
    BalanceRunnerCapability,
  );
}

export function findRunnerInstallation(db: D1<'first'>, runnerId: string) {
  return queryFirst(
    db
      .prepare(
        `
      SELECT auth_mode, auth_subject, revoked_at
      FROM balance_runner_installations WHERE id = ?
    `,
      )
      .bind(runnerId),
    ExistingInstallationRow,
  );
}

export async function recordRunnerHeartbeat(
  db: D1<'first' | 'run'> & D1Batch<'first' | 'run'>,
  heartbeat: v.InferOutput<typeof RunnerHeartbeatBody>,
  auth: AuthorizedRunner,
): Promise<void> {
  const installation = db
    .prepare(
      `
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
    `,
    )
    .bind(
      heartbeat.runner_id,
      heartbeat.display_name,
      auth.authMode,
      auth.subject,
      heartbeat.platform,
      heartbeat.version,
    );

  const capabilities = heartbeat.capabilities.map((capability) =>
    db
      .prepare(
        `
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
      `,
      )
      .bind(
        heartbeat.runner_id,
        capability.capability,
        capability.state,
        heartbeat.session_id,
        capability.current_job_id,
        capability.concurrency,
        capability.detail_code,
      ),
  );

  await db.batch([installation, ...capabilities]);
}
