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
import { updatesHandler } from './handlers/updates';
import { serveFrontend } from './frontend-handler';
import { createRoleConfig, hasSmSAccess } from '../config/auth0-roles.js';

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

// Debug endpoint to test SSE broadcast
router.get('/api/debug/sse-broadcast', async (request, env) => {
  const connectionCount = getActiveConnectionCount();
  await broadcastSSEEvent('debug:test', {
    message: 'Test SSE broadcast',
    timestamp: new Date().toISOString(),
    connections: connectionCount
  });
  return new Response(JSON.stringify({
    success: true,
    message: `Broadcasted test event to ${connectionCount} SSE connections`
  }), {
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

// Auth routes
router.get('/login', (request, env, ctx) => {
  console.log('[Router] /login route matched - calling auth0Handler.login');
  return auth0Handler.login(request);
}); // Redirect directly to Auth0
router.get('/callback', auth0Handler.callback);
router.get('/logout', auth0Handler.logout);

// Auth API endpoint
router.get('/api/auth/me', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  return auth0Handler.me(request);
});

// Polling updates endpoint
router.get('/api/updates', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  return updatesHandler.poll(request);
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
  // Get pending SMS sends for daemon
  try {
    return await controlHandler.getPendingSMS(request);
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
    // Check for session token in cookies
    const cookieHeader = request.headers.get('Cookie');
    let token = null;
    
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').map(c => c.trim());
      const authCookie = cookies.find(c => c.startsWith('auth_token='));
      if (authCookie) {
        token = authCookie.split('=')[1];
      }
    }
    
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
    
    if (!hasSmSAccess(userRoles, roleConfig)) {
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

// Stub WebSocketRoom class for migration purposes
// This will be removed after Durable Objects migration
export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response('WebSocket support removed - migrated to SSE', { status: 410 });
  }
}

