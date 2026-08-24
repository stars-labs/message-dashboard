// Working version with frontend restored
import { handleCORS } from './middleware/cors';
import { handleAuth0 } from './middleware/auth0';
import { requirePermission, enrichUserPermissions } from './middleware/rbac';
import { controlHandler } from './handlers/control';
import { auth0Handler } from './handlers/auth0';
import { phonesHandler } from './handlers/phones';
import { messagesHandler } from './handlers/messages';
import { statsHandler } from './handlers/stats';
import { iccidMappingsHandler } from './handlers/iccid-mappings';
import { healthHandler } from './handlers/health';
import { usersHandler } from './handlers/users';
import { balanceQueriesHandler } from './handlers/balance-queries.js';
import { balanceSkillRunnerHandler } from './handlers/balance-skill-runner.js';
import {
  reconcileTerminalWebBalanceJobs,
  carrierWebBalanceHandler,
} from './handlers/carrier-web-balance.js';
import { balanceRunnersHandler } from './handlers/balance-runners.js';
import { serveFrontend } from './frontend-handler';
import { createRoleConfig, hasAnyRole } from '../config/auth0-roles.js';
import { setupKeywordRoutes } from './api/keywords.js';
import { setupFilterRoutes } from './api/filters.js';
import { setupVerificationRoutes } from './api/verification.js';
import { purgeExpiredMessages } from './utils/message-retention.js';
import { sweepPending } from './utils/spam-backfill.js';
import { reconcileCarrierBillMessages } from './utils/carrier-billing.js';
import { readCookie } from './utils/session-token.js';

// Simple router implementation without itty-router
class SimpleRouter {
  constructor() {
    this.routes = {
      GET: [],
      POST: [],
      PUT: [],
      DELETE: [],
      OPTIONS: []
    };
  }

  get(path, ...handlers) {
    this.routes.GET.push({ path, handlers });
  }

  post(path, ...handlers) {
    this.routes.POST.push({ path, handlers });
  }

  put(path, ...handlers) {
    this.routes.PUT.push({ path, handlers });
  }

  delete(path, ...handlers) {
    this.routes.DELETE.push({ path, handlers });
  }

  options(path, ...handlers) {
    this.routes.OPTIONS.push({ path, handlers });
  }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    // Add env and ctx to request
    request.env = env;
    request.ctx = ctx;

    // Find matching route
    const routes = this.routes[method] || [];

    for (const route of routes) {
      if (route.path === '*' || route.path === pathname || this.matchPath(route.path, pathname)) {
        
        // Extract route parameters if any
        if (route.path.includes(':')) {
          const params = {};
          const patternParts = route.path.split('/');
          const pathParts = pathname.split('/');
          
          for (let i = 0; i < patternParts.length; i++) {
            if (patternParts[i].startsWith(':')) {
              const paramName = patternParts[i].substring(1);
              // Decode: `pathname` keeps percent-encoding, and Auth0 user ids contain
              // '|' (auth0|abc -> auth0%7Cabc). Passing the raw segment on meant it got
              // encoded a second time downstream (auth0%257Cabc), addressing the wrong
              // user. Malformed encoding falls back to the raw value rather than
              // throwing out of the router.
              try {
                params[paramName] = decodeURIComponent(pathParts[i]);
              } catch {
                params[paramName] = pathParts[i];
              }
            }
          }
          
          // Add params to request
          request.params = params;
        }
        
        // Execute handlers in sequence
        let response;
        for (const handler of route.handlers) {
          response = await handler(request, env, ctx);
          if (response) break;
        }
        return response;
      }
    }

    return null;
  }

  matchPath(pattern, pathname) {
    // Simple path matching with support for :param patterns
    if (pattern === pathname) return true;
    if (pattern === '*') return true;

    // Check if pattern starts with pathname for wildcard routes
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return pathname.startsWith(prefix);
    }

    // Check for parameter patterns like /api/iccid-mappings/:id
    if (pattern.includes(':')) {
      const patternParts = pattern.split('/');
      const pathParts = pathname.split('/');
      
      if (patternParts.length !== pathParts.length) {
        return false;
      }
      
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          // This is a parameter, any value matches
          continue;
        }
        if (patternParts[i] !== pathParts[i]) {
          return false;
        }
      }
      
      return true;
    }

    return false;
  }
}

const router = new SimpleRouter();

// CORS preflight
router.options('*', handleCORS);

// Public API routes
router.get('/api/health', (request) => healthHandler.check(request));
router.get('/api/daemon/status', (request) => healthHandler.daemonStatus(request));
// Legacy /favicon.ico requests (browsers ask for it even when index.html declares
// icons) are redirected to the real PNG. This used to return an empty 204, which is
// why the dashboard had no icon at all.
router.get('/favicon.ico', (request) =>
  Response.redirect(new URL('/favicon-32.png', request.url).toString(), 301)
);

// Auth routes
router.get('/login', (request) => auth0Handler.login(request));
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

// Auth API endpoint
router.get('/api/auth/me', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  // Attaches user.permissions, which the client uses to decide which nav items and
  // write controls to render. Without this the response carried roles but no
  // permissions, so the SPA had nothing to gate on.
  await enrichUserPermissions(request, env, ctx);
  return auth0Handler.me(request);
});

// Protected routes - Web UI
router.get('/api/phones', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return phonesHandler.list(request);
});

router.get('/api/messages', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('messages.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return messagesHandler.list(request);
});

router.get('/api/balance-checks', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('messages.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.list(request);
});

router.get('/api/balance-checks/query-preview', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('balances.query')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.preview(request);
});

router.post('/api/balance-checks/query-preview', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('balances.query')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.preview(request);
});

router.get('/api/balance-checks/query-preflight', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('balances.query')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.preflight(request);
});

router.get('/api/balance-runners', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('messages.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceRunnersHandler.status(request);
});

router.post('/api/balance-checks/query', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('balances.query')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.query(request);
});

router.post('/api/balance-checks/query-batch', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('balances.query')(request, env, ctx);
  if (permResponse) return permResponse;
  return balanceQueriesHandler.queryBatch(request);
});

router.post('/api/messages/send', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('messages.send')(request, env, ctx);
  if (permResponse) return permResponse;
  return messagesHandler.send(request);
});

// User + role administration. Admin-only: `users.read`/`users.write` appear solely in
// the admin role's permission set. PUT is a privilege-escalation primitive — see
// server/handlers/users.js for the guards it carries.
router.get('/api/users', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('users.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return usersHandler.list(request);
});

router.put('/api/users/:id/role', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('users.write')(request, env, ctx);
  if (permResponse) return permResponse;
  return usersHandler.setRole(request);
});

router.get('/api/stats', async (request, env, ctx) => {
  // Basic stats (device counts) are public
  // Detailed stats require authentication
  return statsHandler.get(request, env, ctx);
});

// ICCID Mappings routes
router.get('/api/iccid-mappings', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.list(request);
});

router.get('/api/iccid-mappings/:id', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.get(request);
});

router.get('/api/iccid-mappings/by-iccid/:iccid', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.getByIccid(request);
});

router.post('/api/iccid-mappings', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.write')(request, env, ctx);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.create(request);
});

router.put('/api/iccid-mappings/:id', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.write')(request, env, ctx);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.update(request);
});

router.delete('/api/iccid-mappings/:id', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.write')(request, env, ctx);
  if (permResponse) return permResponse;
  return iccidMappingsHandler.delete(request);
});

router.post('/api/iccid-mappings/bulk', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.write')(request, env, ctx);
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Device synchronization endpoint (modems and SIMs separated)
router.post('/api/control/devices', async (request) => {
  // Control devices endpoint hit
  try {
    return await controlHandler.updateDevices(request);
  } catch (error) {
    // Control devices error
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

router.delete('/api/control/messages', async (request) => {
  // Clear all messages endpoint
  try {
    return await controlHandler.clearMessages(request);
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

router.post('/api/control/cleanup-test-data', async (request) => {
  // Cleanup test data endpoint
  try {
    return await controlHandler.cleanupTestData(request);
  } catch (error) {
    // Cleanup error
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

router.get('/api/control/pending-sms', async (request) => {
  // Daemon heartbeat and get pending SMS
  try {
    return await controlHandler.heartbeatAndGetPendingSMS(request);
  } catch (error) {
    // Pending SMS error
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

router.post('/api/control/sms-result', async (request) => {
  // Update SMS send result from daemon
  try {
    return await controlHandler.updateSMSResult(request);
  } catch (error) {
    // SMS result error
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Setup keyword routes
setupKeywordRoutes(router);

// Setup spam/marketing filter rule routes
setupFilterRoutes(router);

// High-confidence verification-code backfill (admin only)
setupVerificationRoutes(router);

// Login page route - removed duplicate, using auth0Handler.login above

// Serve frontend for all other routes - check authentication
router.get('*', async (request, env, ctx) => {
  const url = new URL(request.url);

  // Skip authentication for public routes
  const publicRoutes = [];
  if (publicRoutes.includes(url.pathname)) {
    return serveFrontend(request);
  }

  // For the main app, check if user is authenticated and has the SMS role
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // Shared cookie reader rather than a second inline parser: the previous
    // `authCookie.split('=')[1]` truncated any value containing '=', and
    // `startsWith('auth_token=')` would also have matched a differently named cookie.
    const token = readCookie(request.headers.get('Cookie'), 'auth_token');

    if (!token) {
      // No token - redirect to login
      return Response.redirect(new URL('/login', request.url).toString(), 302);
    }

    // Verify session
    const sessionData = await env.SESSIONS.get(token);
    if (!sessionData) {
      // Invalid session - redirect to login
      return Response.redirect(new URL('/login', request.url).toString(), 302);
    }

    const session = JSON.parse(sessionData);
    if (session.expires_at < Date.now()) {
      // Session expired - redirect to login
      await env.SESSIONS.delete(token);
      return Response.redirect(new URL('/login', request.url).toString(), 302);
    }

    // Check if user has SMS role
    const roleConfig = createRoleConfig(env);
    const user = session.user;
    const userRoles = user.roles || [];

    if (!hasAnyRole(userRoles, roleConfig)) {
      // User doesn't have SMS role - redirect to login with error
      return Response.redirect(new URL('/login?error=no_role', request.url).toString(), 302);
    }
  }

  // Serve the frontend
  return serveFrontend(request);
});

export default {
  async fetch(request, env, ctx) {
    // Worker started - with frontend
    console.log(`[Worker] Received request: ${request.method} ${request.url}`);

    try {

      // Handle regular routes
      const response = await router.handle(request, env, ctx);

      if (!response) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/api' || pathname.startsWith('/api/')) {
          return handleCORS(new Response(JSON.stringify({ error: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          }));
        }

        console.log(`[Worker] No route matched, serving frontend`);
        // No route matched, serve frontend (includes assets)
        return serveFrontend(request);
      }

      console.log(`[Worker] Route matched, returning response`);
      // Add CORS headers to API responses
      if (response) {
        return handleCORS(response);
      }
      return response;

    } catch (error) {
      console.error(`[Worker] Error:`, error);
      // Worker error
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Nightly maintenance (cron in wrangler.toml).
  async scheduled(event, env, ctx) {
    console.log(`[scheduled] cron ${event.cron} firing`);

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
      console.log(`[scheduled] classification: swept ${sweep.processed}, ${sweep.remaining} remaining`);
    } catch (error) {
      console.error('[scheduled] classification sweep failed:', error);
    }

    try {
      const webJobs = await reconcileTerminalWebBalanceJobs(env.DB);
      console.log(`[scheduled] web balance jobs: reconciled ${webJobs.reconciled}`);
    } catch (error) {
      console.error('[scheduled] web balance reconciliation failed:', error);
    }

    try {
      const bills = await reconcileCarrierBillMessages(env.DB);
      console.log(`[scheduled] carrier bills: scanned ${bills.scanned}, detected ${bills.detected}, remaining=${bills.remaining}`);
    } catch (error) {
      console.error('[scheduled] carrier bill reconciliation failed:', error);
    }
  }
};
