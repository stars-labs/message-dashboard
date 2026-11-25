import * as v from 'valibot';
import { queryAll, queryFirst, type D1 } from '../lib/d1.js';

export const AlertName = v.picklist(['daemon_offline', 'sims_offline']);
export type AlertName = v.InferOutput<typeof AlertName>;

const HeartbeatRow = v.object({ last_heartbeat: v.string() });

const OfflineSimRow = v.object({
  sim_index: v.number(),
  sim_status: v.picklist(['no_modem', 'offline', 'sim_error', 'iccid_mismatch']),
});
export type OfflineSim = v.InferOutput<typeof OfflineSimRow>;

const AlertStateRow = v.object({
  first_seen_at: v.string(),
  notified_at: v.nullable(v.string()),
});
export type AlertState = v.InferOutput<typeof AlertStateRow>;

export async function readLastHeartbeat(db: D1<'first'>): Promise<string | null> {
  const row = await queryFirst(
    db.prepare(`SELECT last_heartbeat FROM daemon_health WHERE daemon_id = 'orange-pi-main'`),
    HeartbeatRow,
  );
  return row?.last_heartbeat ?? null;
}

/** SIMs given a modem in the inventory (imei set) that the modem is not serving. */
export function listOfflineAssignedSims(db: D1<'all'>): Promise<OfflineSim[]> {
  return queryAll(
    db.prepare(`
      SELECT sim_index, sim_status
      FROM device_view
      WHERE imei IS NOT NULL AND sim_status != 'active'
      ORDER BY sim_index
    `),
    OfflineSimRow,
  );
}

export function readAlertState(db: D1<'first'>, alert: AlertName): Promise<AlertState | null> {
  return queryFirst(
    db.prepare(`SELECT first_seen_at, notified_at FROM alert_state WHERE alert = ?`).bind(alert),
    AlertStateRow,
  );
}

export async function openAlert(
  db: D1<'run'>,
  alert: AlertName,
  at: string,
  notifiedAt: string | null,
): Promise<void> {
  await db
    .prepare(`INSERT INTO alert_state (alert, first_seen_at, notified_at) VALUES (?, ?, ?)`)
    .bind(alert, at, notifiedAt)
    .run();
}

export async function markAlertNotified(
  db: D1<'run'>,
  alert: AlertName,
  at: string,
): Promise<void> {
  await db.prepare(`UPDATE alert_state SET notified_at = ? WHERE alert = ?`).bind(at, alert).run();
}

export async function closeAlert(db: D1<'run'>, alert: AlertName): Promise<void> {
  await db.prepare(`DELETE FROM alert_state WHERE alert = ?`).bind(alert).run();
}
