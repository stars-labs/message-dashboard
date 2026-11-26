import { RECURRING } from '../shared/recurring.js';
import { expireStaleBalanceChecks } from './db/balance-replies.js';
import { maintainWebBalanceJobs } from './handlers/carrier-web-balance.js';
import type { D1, D1Batch } from './lib/d1.js';
import type { KV } from './lib/kv.js';
import { runAlertChecks, type AlertMailer } from './utils/alerts.js';
import { reconcileCarrierBillMessages } from './utils/carrier-billing.js';
import { purgeExpiredMessages } from './utils/message-retention.js';
import { sweepPending } from './utils/spam-backfill.js';

export interface ScheduledEnv {
  DB: D1 & D1Batch;
  SESSIONS: KV<'get' | 'put'>;
  EMAIL?: AlertMailer;
  ALERT_RECIPIENTS?: string;
}

export async function runScheduled(
  event: { cron: string; scheduledTime: number },
  env: ScheduledEnv,
): Promise<void> {
  console.log(`[scheduled] cron ${event.cron} firing`);

  try {
    const timeouts = await expireStaleBalanceChecks(env.DB);
    console.log(`[scheduled] balance checks: expired ${timeouts.expired}`);
  } catch (error) {
    console.error('[scheduled] balance check maintenance failed:', error);
  }

  try {
    const webJobs = await maintainWebBalanceJobs(env.DB);
    console.log(
      `[scheduled] web balance jobs: expired ${webJobs.expired}, reconciled ${webJobs.reconciled}`,
    );
  } catch (error) {
    console.error('[scheduled] web balance maintenance failed:', error);
  }

  try {
    await runAlertChecks({
      db: env.DB,
      kv: env.SESSIONS,
      mail: env.EMAIL,
      recipients: env.ALERT_RECIPIENTS?.split(',')
        .map((address) => address.trim())
        .filter((address) => address !== ''),
      now: event.scheduledTime,
    });
  } catch (error) {
    console.error('[scheduled] alert delivery failed:', error);
  }

  // The five-minute trigger is for balance response windows and alerts; the heavier work is nightly.
  if (event.cron !== RECURRING.cronNightly.cron) return;

  // Retention before classification: no point classifying messages about to be deleted.
  try {
    const purge = await purgeExpiredMessages(env.DB);
    console.log(`[scheduled] retention: deleted ${purge.deleted}, exhausted=${purge.exhausted}`);
  } catch (error) {
    console.error('[scheduled] retention failed:', error);
  }

  // 'pending' is the cursor, so an interrupted request-scoped sweep self-heals here.
  try {
    const sweep = await sweepPending(env.DB);
    console.log(
      `[scheduled] classification: swept ${sweep.processed}, ${sweep.remaining} remaining`,
    );
  } catch (error) {
    console.error('[scheduled] classification sweep failed:', error);
  }

  try {
    const bills = await reconcileCarrierBillMessages(env.DB);
    console.log(
      `[scheduled] carrier bills: scanned ${bills.scanned}, detected ${bills.detected}, remaining=${bills.remaining}`,
    );
  } catch (error) {
    console.error('[scheduled] carrier bill reconciliation failed:', error);
  }
}
