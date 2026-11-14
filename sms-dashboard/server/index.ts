import type { Permission } from '../config/auth0-roles.js';
import { handleCORS, corsPreflight } from './middleware/cors.js';
import { handleAuth0 } from './middleware/auth0.js';
import { authorize } from './middleware/authorize.js';
import { enrichUserPermissions } from './middleware/rbac.js';
import { controlHandler } from './handlers/control.js';
import { auth0Handler } from './handlers/auth0.js';
import { phonesHandler } from './handlers/phones.js';
import { messagesHandler } from './handlers/messages.js';
import { iccidMappingsHandler } from './handlers/iccid-mappings.js';
import { healthHandler } from './handlers/health.js';
import { usersHandler } from './handlers/users.js';
import { balanceQueriesHandler, expireStaleBalanceChecks } from './handlers/balance-queries.js';
import { balanceSkillRunnerHandler } from './handlers/balance-skill-runner.js';
import {
  maintainWebBalanceJobs,
  carrierWebBalanceHandler,
} from './handlers/carrier-web-balance.js';
import { balanceRunnersHandler } from './handlers/balance-runners.js';
import { carrierBillsHandler } from './handlers/carrier-bills.js';
import { carrierBillingBackfillHandler } from './handlers/carrier-billing-backfill.js';
import { serveFrontend } from './frontend-handler.js';
import { appShellRedirect } from './frontend-gate.js';
import { setupKeywordRoutes } from './api/keywords.js';
import { setupFilterRoutes } from './api/filters.js';
import { setupVerificationRoutes } from './api/verification.js';
import { setupCallRoutes } from './api/calls.js';
import { purgeExpiredMessages } from './utils/message-retention.js';
import { sweepPending } from './utils/spam-backfill.js';
import { reconcileCarrierBillMessages } from './utils/carrier-billing.js';
import { Router } from './router.js';
import type { AppRequest } from './worker-context.js';
import { errorText } from './utils/d1-error.js';
import { json } from './lib/response.js';

const router = new Router<AppRequest>();

function gate(permission: Permission) {
  return (request: AppRequest) => authorize(request, permission);
}

/** Answers a daemon route's unexpected failure with its error text. */
function reportingErrors(handler: (request: AppRequest) => Promise<Response>) {
  return async (request: AppRequest) => {
    try {
      return await handler(request);
    } catch (error) {
      return json({ error: errorText(error) }, 500);
    }
  };
}

router.options('*', corsPreflight);

// Public API routes
router.get('/api/live', () => healthHandler.live());
router.get('/api/health', (request) => healthHandler.check(request));
router.get('/api/daemon/status', (request) => healthHandler.daemonStatus(request));
// Legacy /favicon.ico requests (browsers ask for it even when index.html declares
// icons) are redirected to the real PNG. This used to return an empty 204, which is
// why the dashboard had no icon at all.
router.get('/favicon.ico', (request) =>
  Response.redirect(new URL('/favicon-32.png', request.url).toString(), 301),
);

router.get('/login', (request) => auth0Handler.login(request));
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

router.get('/api/auth/me', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  // Attaches user.permissions, which the client uses to decide which nav items and
  // write controls to render. Without this the response carried roles but no
  // permissions, so the SPA had nothing to gate on.
  enrichUserPermissions(request);
  return auth0Handler.me(request);
});

router.get('/api/phones', gate('phones.read'), (request) => phonesHandler.list(request));

router.get('/api/messages', gate('messages.read'), (request) => messagesHandler.list(request));

router.get('/api/balance-checks', gate('messages.read'), (request) =>
  balanceQueriesHandler.list(request),
);

router.get('/api/balance-checks/status', gate('messages.read'), (request) =>
  balanceQueriesHandler.status(request),
);

router.get('/api/carrier-billing/accounts', gate('bills.read'), (request) =>
  carrierBillsHandler.listAccounts(request),
);

router.post('/api/carrier-billing/backfill/preview', gate('bills.write'), (request) =>
  carrierBillingBackfillHandler.preview(request),
);

router.post('/api/carrier-billing/backfill/execute', gate('bills.write'), (request) =>
  carrierBillingBackfillHandler.execute(request),
);

router.get('/api/carrier-bills', gate('bills.read'), (request) =>
  carrierBillsHandler.list(request),
);

router.get('/api/carrier-bills/:id', gate('bills.read'), (request) =>
  carrierBillsHandler.get(request),
);

for (const [path, action] of [
  ['/api/carrier-bills/:id/payment-planned', 'paymentPlanned'],
  ['/api/carrier-bills/:id/mark-paid', 'markPaid'],
  ['/api/carrier-bills/:id/waive', 'waive'],
  ['/api/carrier-bills/:id/reopen', 'reopen'],
] as const) {
  router.post(path, gate('bills.write'), (request) => carrierBillsHandler[action](request));
}

router.get('/api/balance-checks/query-preview', gate('balances.query'), (request) =>
  balanceQueriesHandler.preview(request),
);

router.post('/api/balance-checks/query-preview', gate('balances.query'), (request) =>
  balanceQueriesHandler.preview(request),
);

router.get('/api/balance-checks/query-preflight', gate('balances.query'), (request) =>
  balanceQueriesHandler.preflight(request),
);

router.get('/api/balance-runners', gate('messages.read'), (request) =>
  balanceRunnersHandler.status(request),
);

router.post('/api/balance-checks/query', gate('balances.query'), (request) =>
  balanceQueriesHandler.query(request),
);

router.post('/api/balance-checks/query-batch', gate('balances.query'), (request) =>
  balanceQueriesHandler.queryBatch(request),
);

router.get('/api/balance-checks/:id', gate('messages.read'), (request) =>
  balanceQueriesHandler.detail(request),
);

router.post('/api/messages/send', gate('messages.send'), (request) =>
  messagesHandler.send(request),
);

// User + role administration. Admin-only: `users.read`/`users.write` appear solely in
// the admin role's permission set. PUT is a privilege-escalation primitive — see
// server/handlers/users.ts for the guards it carries.
router.get('/api/users', gate('users.read'), (request) => usersHandler.list(request));

router.put('/api/users/:id/role', gate('users.write'), (request) => usersHandler.setRole(request));

// ICCID Mappings routes
router.get('/api/iccid-mappings', gate('phones.read'), (request) =>
  iccidMappingsHandler.list(request),
);

router.get('/api/iccid-mappings/:id', gate('phones.read'), (request) =>
  iccidMappingsHandler.get(request),
);

router.get('/api/iccid-mappings/by-iccid/:iccid', gate('phones.read'), (request) =>
  iccidMappingsHandler.getByIccid(request),
);

router.post('/api/iccid-mappings', gate('phones.write'), (request) =>
  iccidMappingsHandler.create(request),
);

router.put('/api/iccid-mappings/:id', gate('phones.write'), (request) =>
  iccidMappingsHandler.update(request),
);

router.delete('/api/iccid-mappings/:id', gate('phones.write'), (request) =>
  iccidMappingsHandler.delete(request),
);

router.post('/api/iccid-mappings/bulk', gate('phones.write'), (request) =>
  iccidMappingsHandler.bulkImport(request),
);

// Daemon and runner routes: each handler authenticates its caller itself, by API key
// or runner token.
router.post(
  '/api/control/messages',
  reportingErrors((request) => controlHandler.uploadMessages(request)),
);
router.post(
  '/api/control/devices',
  reportingErrors((request) => controlHandler.updateDevices(request)),
);
router.delete(
  '/api/control/messages',
  reportingErrors((request) => controlHandler.clearMessages(request)),
);
router.post(
  '/api/control/cleanup-test-data',
  reportingErrors((request) => controlHandler.cleanupTestData(request)),
);
router.get(
  '/api/control/pending-sms',
  reportingErrors((request) => controlHandler.getPendingSMS(request)),
);
router.post(
  '/api/control/sms-result',
  reportingErrors((request) => controlHandler.updateSMSResult(request)),
);
router.post(
  '/api/control/heartbeat',
  reportingErrors((request) => controlHandler.heartbeat(request)),
);

router.post('/api/control/balance-checks', (request) => balanceQueriesHandler.create(request));

router.post('/api/control/balance-checks/continue', (request) =>
  balanceQueriesHandler.continue(request),
);

router.post('/api/control/balance-checks/retry', (request) => balanceQueriesHandler.retry(request));

router.post('/api/control/balance-checks/stop', (request) => balanceQueriesHandler.stop(request));

router.post('/api/control/balance-runners/heartbeat', (request) =>
  balanceRunnersHandler.heartbeat(request),
);

router.get('/api/control/balance-runners/check', (request) => balanceRunnersHandler.check(request));

router.get('/api/control/balance-skills/jobs/claim', (request) =>
  balanceSkillRunnerHandler.claim(request),
);

router.post('/api/control/balance-skills/jobs/:id/decision', (request) =>
  balanceSkillRunnerHandler.decide(request),
);

router.post('/api/control/balance-skills/jobs/:id/release', (request) =>
  balanceSkillRunnerHandler.release(request),
);

router.get('/api/control/carrier-web-balance/jobs/claim', (request) =>
  carrierWebBalanceHandler.claim(request),
);

router.post('/api/control/carrier-web-balance/jobs/:id/otp-requested', (request) =>
  carrierWebBalanceHandler.otpRequested(request),
);

router.get('/api/control/carrier-web-balance/jobs/:id/otp', (request) =>
  carrierWebBalanceHandler.otp(request),
);

router.post('/api/control/carrier-web-balance/jobs/:id/heartbeat', (request) =>
  carrierWebBalanceHandler.heartbeat(request),
);

router.post('/api/control/carrier-web-balance/jobs/:id/complete', (request) =>
  carrierWebBalanceHandler.complete(request),
);

router.post('/api/control/carrier-web-balance/jobs/:id/fail', (request) =>
  carrierWebBalanceHandler.fail(request),
);

router.post('/api/control/carrier-web-balance/jobs/:id/release', (request) =>
  carrierWebBalanceHandler.release(request),
);

setupKeywordRoutes(router);
setupFilterRoutes(router);
setupVerificationRoutes(router);
setupCallRoutes(router);

router.get(
  '*',
  async (request) => (await appShellRedirect(request, request.env)) ?? serveFrontend(request),
);

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The router and middleware read env and ctx from the request itself.
    const request: AppRequest = Object.assign(incoming, { env, ctx });
    console.log(`[Worker] Received request: ${request.method} ${request.url}`);

    try {
      const response = await router.handle(request);

      if (!response) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/api' || pathname.startsWith('/api/')) {
          return handleCORS(json({ error: 'Not Found' }, 404));
        }

        console.log(`[Worker] No route matched, serving frontend`);
        return serveFrontend(request);
      }

      console.log(`[Worker] Route matched, returning response`);
      return handleCORS(response);
    } catch (error) {
      console.error(`[Worker] Error:`, error);
      return json({ error: 'Internal Server Error' }, 500);
    }
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
