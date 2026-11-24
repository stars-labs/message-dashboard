import { handleCORS, corsPreflight } from './middleware/cors.js';
import { auth0Handler } from './handlers/auth0.js';
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
// Browsers ask for /favicon.ico even when index.html declares icons.
router.get('/favicon.ico', (request) =>
  Response.redirect(new URL('/favicon-32.png', request.url).toString(), 301),
);

router.get('/login', (request) => auth0Handler.login(request));
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

// /api is never a page: an unknown API path falls through to the 404 below.
router.get('*', async (request) =>
  isApiPath(request)
    ? null
    : ((await appShellRedirect(request, request.env)) ?? serveFrontend(request)),
);

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
