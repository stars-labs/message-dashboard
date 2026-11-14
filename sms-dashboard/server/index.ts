// Working version with frontend restored
import { handleCORS, corsPreflight } from './middleware/cors';
import { handleAuth0 } from './middleware/auth0';
import { requirePermission, enrichUserPermissions } from './middleware/rbac';
import { controlHandler } from './handlers/control';
import { auth0Handler } from './handlers/auth0';
import { phonesHandler } from './handlers/phones';
import { messagesHandler } from './handlers/messages';
import { iccidMappingsHandler } from './handlers/iccid-mappings';
import { healthHandler } from './handlers/health';
import { usersHandler } from './handlers/users';
import { balanceQueriesHandler, expireStaleBalanceChecks } from './handlers/balance-queries.js';
import { balanceSkillRunnerHandler } from './handlers/balance-skill-runner.js';
import {
  maintainWebBalanceJobs,
  carrierWebBalanceHandler,
} from './handlers/carrier-web-balance.js';
import { balanceRunnersHandler } from './handlers/balance-runners.js';
import { carrierBillsHandler } from './handlers/carrier-bills.js';
import { carrierBillingBackfillHandler } from './handlers/carrier-billing-backfill.js';
import { serveFrontend } from './frontend-handler';
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

// CORS preflight
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

// Auth routes
router.get('/login', (request) => auth0Handler.login(request));
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

// Auth API endpoint
router.get('/api/auth/me', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  // Attaches user.permissions, which the client uses to decide which nav items and
  // write controls to render. Without this the response carried roles but no
  // permissions, so the SPA had nothing to gate on.
  enrichUserPermissions(request);
  return auth0Handler.me(request);
});

// Protected routes - Web UI
router.get('/api/phones', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.read')(request);
  if (permResponse) return permResponse;
  return phonesHandler.list(request);
});

router.get('/api/messages', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.read')(request);
  if (permResponse) return permResponse;
  return messagesHandler.list(request);
});

router.get('/api/balance-checks', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.read')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.list(request);
});

router.get('/api/balance-checks/status', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.read')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.status(request);
});

router.get('/api/carrier-billing/accounts', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('bills.read')(request);
  if (permResponse) return permResponse;
  return carrierBillsHandler.listAccounts(request);
});

router.post('/api/carrier-billing/backfill/preview', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('bills.write')(request);
  if (permResponse) return permResponse;
  return carrierBillingBackfillHandler.preview(request);
});

router.post('/api/carrier-billing/backfill/execute', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('bills.write')(request);
  if (permResponse) return permResponse;
  return carrierBillingBackfillHandler.execute(request);
});

router.get('/api/carrier-bills', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('bills.read')(request);
  if (permResponse) return permResponse;
  return carrierBillsHandler.list(request);
});

router.get('/api/carrier-bills/:id', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('bills.read')(request);
  if (permResponse) return permResponse;
  return carrierBillsHandler.get(request);
});

for (const [path, action] of [
  ['/api/carrier-bills/:id/payment-planned', 'paymentPlanned'],
  ['/api/carrier-bills/:id/mark-paid', 'markPaid'],
  ['/api/carrier-bills/:id/waive', 'waive'],
  ['/api/carrier-bills/:id/reopen', 'reopen'],
] as const) {
  router.post(path, async (request) => {
    const authResponse = await handleAuth0(request);
    if (authResponse) return authResponse;
    enrichUserPermissions(request);
    const permResponse = requirePermission('bills.write')(request);
    if (permResponse) return permResponse;
    return carrierBillsHandler[action](request);
  });
}

router.get('/api/balance-checks/query-preview', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('balances.query')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.preview(request);
});

router.post('/api/balance-checks/query-preview', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('balances.query')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.preview(request);
});

router.get('/api/balance-checks/query-preflight', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('balances.query')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.preflight(request);
});

router.get('/api/balance-runners', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.read')(request);
  if (permResponse) return permResponse;
  return balanceRunnersHandler.status(request);
});

router.post('/api/balance-checks/query', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('balances.query')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.query(request);
});

router.post('/api/balance-checks/query-batch', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('balances.query')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.queryBatch(request);
});

router.get('/api/balance-checks/:id', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.read')(request);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.detail(request);
});

router.post('/api/messages/send', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('messages.send')(request);
  if (permResponse) return permResponse;
  return messagesHandler.send(request);
});

// User + role administration. Admin-only: `users.read`/`users.write` appear solely in
// the admin role's permission set. PUT is a privilege-escalation primitive — see
// server/handlers/users.js for the guards it carries.
router.get('/api/users', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('users.read')(request);
  if (permResponse) return permResponse;
  return usersHandler.list(request);
});

router.put('/api/users/:id/role', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('users.write')(request);
  if (permResponse) return permResponse;
  return usersHandler.setRole(request);
});

// ICCID Mappings routes
router.get('/api/iccid-mappings', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.read')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.list(request);
});

router.get('/api/iccid-mappings/:id', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.read')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.get(request);
});

router.get('/api/iccid-mappings/by-iccid/:iccid', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.read')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.getByIccid(request);
});

router.post('/api/iccid-mappings', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.write')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.create(request);
});

router.put('/api/iccid-mappings/:id', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.write')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.update(request);
});

router.delete('/api/iccid-mappings/:id', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.write')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.delete(request);
});

router.post('/api/iccid-mappings/bulk', async (request) => {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission('phones.write')(request);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.bulkImport(request);
});

// User Overrides routes removed - obsolete with new schema (user-authoritative sims table)
// All SIM management now goes through /api/iccid-mappings endpoints

// Control server routes - API Key auth
router.post('/api/control/messages', async (request) => {
  // Control messages endpoint hit
  try {
    return await controlHandler.uploadMessages(request);
  } catch (error) {
    // Control messages error
    return json({ error: errorText(error) }, 500);
  }
});

// Device synchronization endpoint (modems and SIMs separated)
router.post('/api/control/devices', async (request) => {
  // Control devices endpoint hit
  try {
    return await controlHandler.updateDevices(request);
  } catch (error) {
    // Control devices error
    return json({ error: errorText(error) }, 500);
  }
});

router.delete('/api/control/messages', async (request) => {
  // Clear all messages endpoint
  try {
    return await controlHandler.clearMessages(request);
  } catch (error) {
    return json({ error: errorText(error) }, 500);
  }
});

router.post('/api/control/cleanup-test-data', async (request) => {
  // Cleanup test data endpoint
  try {
    return await controlHandler.cleanupTestData(request);
  } catch (error) {
    // Cleanup error
    return json({ error: errorText(error) }, 500);
  }
});

router.get('/api/control/pending-sms', async (request) => {
  // Poll and claim pending SMS; liveness is reported through /api/control/heartbeat.
  try {
    return await controlHandler.getPendingSMS(request);
  } catch (error) {
    // Pending SMS error
    return json({ error: errorText(error) }, 500);
  }
});

router.post('/api/control/sms-result', async (request) => {
  // Update SMS send result from daemon
  try {
    return await controlHandler.updateSMSResult(request);
  } catch (error) {
    // SMS result error
    return json({ error: errorText(error) }, 500);
  }
});

router.post('/api/control/balance-checks', async (request) => {
  return balanceQueriesHandler.create(request);
});

router.post('/api/control/balance-checks/continue', async (request) => {
  return balanceQueriesHandler.continue(request);
});

router.post('/api/control/balance-checks/retry', async (request) => {
  return balanceQueriesHandler.retry(request);
});

router.post('/api/control/balance-checks/stop', async (request) => {
  return balanceQueriesHandler.stop(request);
});

router.post('/api/control/balance-runners/heartbeat', async (request) => {
  return balanceRunnersHandler.heartbeat(request);
});

router.get('/api/control/balance-runners/check', async (request) => {
  return balanceRunnersHandler.check(request);
});

router.get('/api/control/balance-skills/jobs/claim', async (request) => {
  return balanceSkillRunnerHandler.claim(request);
});

router.post('/api/control/balance-skills/jobs/:id/decision', async (request) => {
  return balanceSkillRunnerHandler.decide(request);
});

router.post('/api/control/balance-skills/jobs/:id/release', async (request) => {
  return balanceSkillRunnerHandler.release(request);
});

router.get('/api/control/carrier-web-balance/jobs/claim', async (request) => {
  return carrierWebBalanceHandler.claim(request);
});

router.post('/api/control/carrier-web-balance/jobs/:id/otp-requested', async (request) => {
  return carrierWebBalanceHandler.otpRequested(request);
});

router.get('/api/control/carrier-web-balance/jobs/:id/otp', async (request) => {
  return carrierWebBalanceHandler.otp(request);
});

router.post('/api/control/carrier-web-balance/jobs/:id/heartbeat', async (request) => {
  return carrierWebBalanceHandler.heartbeat(request);
});

router.post('/api/control/carrier-web-balance/jobs/:id/complete', async (request) => {
  return carrierWebBalanceHandler.complete(request);
});

router.post('/api/control/carrier-web-balance/jobs/:id/fail', async (request) => {
  return carrierWebBalanceHandler.fail(request);
});

router.post('/api/control/carrier-web-balance/jobs/:id/release', async (request) => {
  return carrierWebBalanceHandler.release(request);
});

router.post('/api/control/heartbeat', async (request) => {
  // Daemon heartbeat endpoint
  try {
    return await controlHandler.heartbeat(request);
  } catch (error) {
    // Heartbeat error
    return json({ error: errorText(error) }, 500);
  }
});

// Setup keyword routes
setupKeywordRoutes(router);

// Setup spam/marketing filter rule routes
setupFilterRoutes(router);

// High-confidence verification-code backfill (admin only)
setupVerificationRoutes(router);
setupCallRoutes(router);

// Login page route - removed duplicate, using auth0Handler.login above

// Serve frontend for all other routes - check authentication
router.get('*', async (request) => {
  const url = new URL(request.url);

  // Routes that bypass the session gate. Empty today: everything except the
  // explicit /login, /callback and /api paths below goes through auth.
  const publicRoutes: string[] = [];
  if (publicRoutes.includes(url.pathname)) {
    return serveFrontend(request);
  }

  return (await appShellRedirect(request, request.env)) ?? serveFrontend(request);
});

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The router and middleware read env and ctx from the request itself.
    const request: AppRequest = Object.assign(incoming, { env, ctx });
    console.log(`[Worker] Received request: ${request.method} ${request.url}`);

    try {
      // Handle regular routes
      const response = await router.handle(request);

      if (!response) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/api' || pathname.startsWith('/api/')) {
          return handleCORS(json({ error: 'Not Found' }, 404));
        }

        console.log(`[Worker] No route matched, serving frontend`);
        // No route matched, serve frontend (includes assets)
        return serveFrontend(request);
      }

      console.log(`[Worker] Route matched, returning response`);
      // Add CORS headers to API responses
      return handleCORS(response);
    } catch (error) {
      console.error(`[Worker] Error:`, error);
      // Worker error
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
