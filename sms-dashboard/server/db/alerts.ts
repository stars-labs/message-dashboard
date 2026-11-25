import * as v from 'valibot';
import { queryFirst, type D1 } from '../lib/d1.js';

type AlertName = 'daemon_offline';

const HeartbeatRow = v.object({ last_heartbeat: v.string() });

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
