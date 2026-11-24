import { expireStaleBalanceChecks } from './handlers/balance-queries.js';
import { maintainWebBalanceJobs } from './handlers/carrier-web-balance.js';
import { purgeExpiredMessages } from './utils/message-retention.js';
import { sweepPending } from './utils/spam-backfill.js';
import { reconcileCarrierBillMessages } from './utils/carrier-billing.js';
import { handleRequest } from './app.js';
import type { AppRequest } from './worker-context.js';

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const request: AppRequest = Object.assign(incoming, { env, ctx });
    return handleRequest(request);
  },

  async scheduled(event: { cron: string }, env: Env) {
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

    // The five-minute trigger is only for balance response windows; the heavier work is nightly.
    if (event.cron !== '17 4 * * *') return;

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
  },
} satisfies ExportedHandler<Env>;
export { CallState } from './handlers/call-state.js';
