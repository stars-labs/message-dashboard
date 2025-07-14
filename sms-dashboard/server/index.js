// Working version with frontend restored
import { handleCORS } from './middleware/cors';
import { handleAuth0 } from './middleware/auth0';
import { requirePermission, enrichUserPermissions } from './middleware/rbac-simple';
import { controlHandler } from './handlers/control';
import { auth0Handler } from './handlers/auth0';
import { phonesHandler } from './handlers/phones';
import { messagesHandler } from './handlers/messages';
import { statsHandler } from './handlers/stats';
import { usersHandler } from './handlers/users';
import { groupsHandler } from './handlers/groups';
import { iccidMappingsHandler } from './handlers/iccid-mappings';
import { sseHandler } from './handlers/sse';
import { serveFrontend } from './frontend-handler';
import { WebSocketRoom } from './durable-objects/WebSocketRoom';

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

  options(path, ...handlers) {
    this.routes.OPTIONS.push({ path, handlers });
  }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    console.log(`[Router] Handling ${method} ${pathname}`);

    // Add env and ctx to request
    request.env = env;
    request.ctx = ctx;

    // Find matching route
    const routes = this.routes[method] || [];
    console.log(`[Router] Available routes for ${method}: ${routes.map(r => r.path).join(', ')}`);
    
    for (const route of routes) {
      if (route.path === '*' || route.path === pathname || this.matchPath(route.path, pathname)) {
        console.log(`[Router] Matched route: ${route.path}`);
        // Execute handlers in sequence
        let response;
        for (const handler of route.handlers) {
          response = await handler(request, env, ctx);
          if (response) break;
        }
        return response;
      }
    }

    console.log(`[Router] No matching route found for ${pathname}`);
    return null;
  }

  matchPath(pattern, pathname) {
    // Simple path matching (doesn't support params like :id)
    if (pattern === pathname) return true;
    if (pattern === '*') return true;
    
    // Check if pattern starts with pathname for wildcard routes
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return pathname.startsWith(prefix);
    }
    
    return false;
  }
}

const router = new SimpleRouter();

// CORS preflight
router.options('*', handleCORS);

// Public API routes
router.get('/api/health', () => new Response('OK', { status: 200 }));

// Debug endpoint to test WebSocket broadcast
router.get('/api/debug/broadcast', async (request, env) => {
  const { broadcastEvent } = await import('./utils/websocket');
  const result = await broadcastEvent(env, 'phones:updated', [{
    id: 'SIM_DEBUG',
    signal: 99,
    status: 'online'
  }]);
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
});

// Test route to check HTML response
router.get('/test-html', () => {
  return new Response('<html><body>Test HTML</body></html>', {
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache'
    }
  });
});

// Auth routes (not under /api since they're redirects, not API endpoints)
router.get('/login', auth0Handler.login);
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

// Auth API endpoint
router.get('/api/auth/me', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  return auth0Handler.me(request);
});

// SSE endpoint for real-time updates
router.get('/api/sse', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  return sseHandler(request);
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

router.post('/api/messages/send', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('messages.send')(request, env, ctx);
  if (permResponse) return permResponse;
  return messagesHandler.send(request);
});

router.get('/api/stats', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('messages.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return statsHandler.get(request);
});

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

router.post('/api/control/phones', async (request) => {
  // Control phones endpoint hit
  try {
    return await controlHandler.updatePhones(request);
  } catch (error) {
    // Control phones error
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Serve frontend for all other routes
router.get('*', serveFrontend);

export default {
  async fetch(request, env, ctx) {
    // Worker started - with frontend
    console.log(`[Worker] Received request: ${request.method} ${request.url}`);
    
    try {
      // Handle WebSocket endpoint directly (not through router)
      const url = new URL(request.url);
      if (url.pathname === '/api/ws') {
        console.log(`[Worker] WebSocket request detected`);
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
          return new Response('Expected Upgrade: websocket', { status: 426 });
        }
        
        // Get Durable Object
        const roomId = env.WEBSOCKET_ROOMS.idFromName('global');
        const room = env.WEBSOCKET_ROOMS.get(roomId);
        
        // Forward to Durable Object
        return room.fetch(request);
      }
      
      // Handle regular routes
      const response = await router.handle(request, env, ctx);
      
      if (!response) {
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
  }
};

// Export WebSocketRoom from durable objects
export { WebSocketRoom };