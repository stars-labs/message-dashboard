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
import { userOverridesHandler } from './handlers/user-overrides';
import { updatesHandler } from './handlers/updates';
import { healthHandler } from './handlers/health';
import { serveFrontend } from './frontend-handler';
import { createRoleConfig, hasSmSAccess } from '../config/auth0-roles.js';
import { setupKeywordRoutes } from './api/keywords.js';

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
              params[paramName] = pathParts[i];
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
router.get('/favicon.ico', () => new Response(null, { status: 204 }));

// Auth routes
router.get('/login', (request) => auth0Handler.login(request));
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

// User Overrides routes (for phone number overrides)
router.get('/api/user-overrides', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return userOverridesHandler.list(request);
});

router.get('/api/user-overrides/sim', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.read')(request, env, ctx);
  if (permResponse) return permResponse;
  return userOverridesHandler.get(request);
});

router.put('/api/user-overrides/sim', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.write')(request, env, ctx);
  if (permResponse) return permResponse;
  return userOverridesHandler.update(request);
});

router.delete('/api/user-overrides/sim', async (request, env, ctx) => {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission('phones.write')(request, env, ctx);
  if (permResponse) return permResponse;
  return userOverridesHandler.remove(request);
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

// New clean endpoint for devices (modems and SIMs separated) 
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


