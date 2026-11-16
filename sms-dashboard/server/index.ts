import { expireStaleBalanceChecks } from './handlers/balance-queries.js';
import { maintainWebBalanceJobs } from './handlers/carrier-web-balance.js';
import { purgeExpiredMessages } from './utils/message-retention.js';
import { sweepPending } from './utils/spam-backfill.js';
import { reconcileCarrierBillMessages } from './utils/carrier-billing.js';
import { handleRequest } from './app.js';
import type { AppRequest } from './worker-context.js';

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The router and middleware read env and ctx from the request itself.
    const request: AppRequest = Object.assign(incoming, { env, ctx });
    return handleRequest(request);
  },

  // Nightly maintenance (cron in wrangler.toml).
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

    // The five-minute trigger exists only for balance response windows. Keep the
    // heavier retention and full-database reconciliation on the nightly trigger.
    if (event.cron !== '17 4 * * *') return;

    // Retention first: no point classifying messages that are about to be deleted.
    try {
      const purge = await purgeExpiredMessages(env.DB);
      console.log(`[scheduled] retention: deleted ${purge.deleted}, exhausted=${purge.exhausted}`);
    } catch (error) {
      console.error('[scheduled] retention failed:', error);
    }

    // Then finish any classification a request-scoped sweep ran out of time for.
    // 'pending' is the cursor, so this self-heals an interrupted backfill.
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
export { CallState } from './api/call-state.js';
