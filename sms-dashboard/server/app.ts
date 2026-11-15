import { handleCORS, corsPreflight } from './middleware/cors.js';
import { auth0Handler } from './handlers/auth0.js';
import { carrierWebBalanceHandler } from './handlers/carrier-web-balance.js';
import { serveFrontend } from './frontend-handler.js';
import { appShellRedirect } from './frontend-gate.js';
import { Router } from './router.js';
import { contractRoutes, handleContract } from './contract/handler.js';
import { problemResponse } from './contract/errors.js';
import type { AppRequest } from './worker-context.js';
import { json } from './lib/response.js';

const router = new Router<AppRequest>();

function isApiPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === '/api' || pathname.startsWith('/api/');
}

router.options('*', corsPreflight);

// Outside the contract for good: browser redirects, not the JSON API.
// Legacy /favicon.ico requests (browsers ask for it even when index.html declares
// icons) are redirected to the real PNG. This used to return an empty 204, which is
// why the dashboard had no icon at all.
router.get('/favicon.ico', (request) =>
  Response.redirect(new URL('/favicon-32.png', request.url).toString(), 301),
);

router.get('/login', (request) => auth0Handler.login(request));
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

// Daemon and runner routes: each handler authenticates its caller itself, by API key
// or runner token.

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

// /api is never a page: an unknown API path falls through to the 404 below.
router.get('*', async (request) =>
  isApiPath(request)
    ? null
    : ((await appShellRedirect(request, request.env)) ?? serveFrontend(request)),
);

/** Every route the app serves, in dispatch order: the contract first, then the Router. */
export function routeTable() {
  return [...contractRoutes(), ...router.routes()];
}

export async function handleRequest(request: AppRequest): Promise<Response> {
  console.log(`[Worker] Received request: ${request.method} ${request.url}`);

  try {
    const response = (await handleContract(request)) ?? (await router.handle(request));

    if (!response) {
      if (isApiPath(request)) {
        const { pathname } = new URL(request.url);
        return handleCORS(
          problemResponse(404, 'NOT_FOUND', `No route for ${request.method} ${pathname}`),
        );
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
}
