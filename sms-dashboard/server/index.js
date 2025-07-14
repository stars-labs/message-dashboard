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

    // Add env and ctx to request
    request.env = env;
    request.ctx = ctx;

    // Find matching route
    const routes = this.routes[method] || [];
    
    for (const route of routes) {
      if (route.path === '*' || route.path === pathname || this.matchPath(route.path, pathname)) {
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
    
    try {
      // Handle WebSocket endpoint directly (not through router)
      const url = new URL(request.url);
      if (url.pathname === '/api/ws') {
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
        // No route matched, serve frontend
        const frontendResponse = serveFrontend(request);
        return handleCORS(frontendResponse);
      }
      
      // Add CORS headers
      return handleCORS(response);
      
    } catch (error) {
      // Worker error
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// Export WebSocketRoom to satisfy Durable Object binding
export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  
  async fetch(request) {
    // For now, return a proper WebSocket upgrade response
    // even if we don't handle messages yet
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    
    // Accept the WebSocket connection
    server.accept();
    
    // Send initial connection message
    server.send(JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString()
    }));
    
    // Handle incoming messages (placeholder)
    server.addEventListener('message', event => {
      // Echo messages for now
      server.send(JSON.stringify({
        type: 'echo',
        data: event.data,
        timestamp: new Date().toISOString()
      }));
    });
    
    // Handle close
    server.addEventListener('close', event => {
      // Cleanup if needed
    });
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}