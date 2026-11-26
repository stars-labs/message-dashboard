import type { Database } from 'bun:sqlite';

/** Who a runner signed in as: the shared API key, or an Auth0 device token for `subject`. */
export type RunnerOwner =
  { authMode: 'legacy_api_key'; subject: null } | { authMode: 'auth0_device'; subject: string };

export const LEGACY_RUNNER: RunnerOwner = { authMode: 'legacy_api_key', subject: null };

/**
 * What a Balance Agent's first heartbeat leaves behind: its installation, and both
 * capabilities under `sessionId`, the runner_id its job calls then carry.
 */
export function registerRunnerSession(
  sqlite: Database,
  sessionId: string,
  owner: RunnerOwner = LEGACY_RUNNER,
  { installationId = `installation-${sessionId}`, revoked = false } = {},
): void {
  sqlite
    .query(
      `INSERT INTO balance_runner_installations (
         id, display_name, auth_mode, auth_subject, platform, version, revoked_at
       ) VALUES (?, 'Runner', ?, ?, 'darwin', '1.0.0', ?)`,
    )
    .run(installationId, owner.authMode, owner.subject, revoked ? '2026-11-01 08:00:00' : null);
  for (const capability of ['sms_ai', 'carrier_browser']) {
    sqlite
      .query(
        `INSERT INTO balance_runner_capabilities (runner_id, capability, state, session_id)
         VALUES (?, ?, 'ready', ?)`,
      )
      .run(installationId, capability, sessionId);
  }
}
