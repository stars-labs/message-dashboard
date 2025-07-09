import { Router } from 'itty-router';
import { handleAuth0 } from './middleware/auth0';
import { handleCORS } from './middleware/cors';
import { requirePermission, enrichUserPermissions } from './middleware/rbac-simple';
import { phonesHandler } from './handlers/phones';
import { messagesHandler } from './handlers/messages';
import { statsHandler } from './handlers/stats';
import { controlHandler } from './handlers/control';
import { auth0Handler } from './handlers/auth0';
import { usersHandler } from './handlers/users';
import { groupsHandler } from './handlers/groups';
import { iccidMappingsHandler } from './handlers/iccid-mappings';
import { sseHandler } from './handlers/sse';
import { WebSocketRoom } from './durable-objects/WebSocketRoom';
import { getAPIDocsHTML } from './pages/api-docs';
import { serveFrontend } from './frontend-handler';

const router = Router();

// CORS preflight
router.options('*', handleCORS);

// Public API routes
router.get('/api/health', () => new Response('OK', { status: 200 }));

// WebSocket diagnostic endpoint
router.get('/api/ws-diagnostics', async (request) => {
  const { env } = request;
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  
  try {
    // Check Durable Objects binding
    const hasDurableObjects = !!env.WEBSOCKET_ROOMS;
    let roomId = null;
    let roomAccessible = false;
    
    if (hasDurableObjects) {
      try {
        roomId = env.WEBSOCKET_ROOMS.idFromName('global');
        const room = env.WEBSOCKET_ROOMS.get(roomId);
        // Test if we can fetch from the room
        const testResponse = await room.fetch(new Request('https://test/health'));
        roomAccessible = true;
      } catch (error) {
        console.error('Room access error:', error);
      }
    }
    
    // Check session if token provided
    let sessionValid = false;
    let sessionData = null;
    if (token) {
      const rawSession = await env.SESSIONS.get(token);
      if (rawSession) {
        sessionValid = true;
        sessionData = JSON.parse(rawSession);
      }
    }
    
    // Check WebSocket support
    const upgradeHeader = request.headers.get('Upgrade');
    const connectionHeader = request.headers.get('Connection');
    
    return new Response(JSON.stringify({
      success: true,
      diagnostics: {
        durableObjects: {
          bindingExists: hasDurableObjects,
          roomId: roomId?.toString(),
          roomAccessible: roomAccessible
        },
        session: {
          tokenProvided: !!token,
          sessionValid: sessionValid,
          user: sessionData?.user?.email
        },
        headers: {
          upgrade: upgradeHeader,
          connection: connectionHeader,
          origin: request.headers.get('Origin'),
          userAgent: request.headers.get('User-Agent')
        },
        url: {
          protocol: url.protocol,
          hostname: url.hostname,
          pathname: url.pathname
        },
        alternatives: {
          sse: '/api/sse',
          polling: 'Consider implementing long-polling as fallback'
        }
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// Auth routes
router.get('/api/auth/login', auth0Handler.login);
router.get('/api/auth/callback', auth0Handler.callback);
router.get('/api/auth/logout', auth0Handler.logout);
router.get('/api/auth/me', handleAuth0, auth0Handler.me);

// Protected routes - Web UI
router.get('/api/phones', handleAuth0, enrichUserPermissions, requirePermission('phones.read'), phonesHandler.list);
router.get('/api/phones/:id', handleAuth0, enrichUserPermissions, requirePermission('phones.read'), phonesHandler.get);
router.get('/api/messages', handleAuth0, enrichUserPermissions, requirePermission('messages.read'), messagesHandler.list);
router.get('/api/messages/:id', handleAuth0, enrichUserPermissions, requirePermission('messages.read'), messagesHandler.get);
router.post('/api/messages/send', handleAuth0, enrichUserPermissions, requirePermission('messages.send'), messagesHandler.send);
router.get('/api/stats', handleAuth0, enrichUserPermissions, requirePermission('messages.read'), statsHandler.get);

// User management routes
router.get('/api/users', handleAuth0, enrichUserPermissions, requirePermission('users.read'), usersHandler.list);
router.get('/api/users/:id', handleAuth0, enrichUserPermissions, requirePermission('users.read'), usersHandler.get);
router.put('/api/users/:id', handleAuth0, enrichUserPermissions, requirePermission('users.write'), usersHandler.update);
router.delete('/api/users/:id', handleAuth0, enrichUserPermissions, requirePermission('users.delete'), usersHandler.delete);
router.put('/api/users/settings', handleAuth0, usersHandler.updateSettings);

// Group management routes
router.get('/api/groups', handleAuth0, enrichUserPermissions, requirePermission('groups.read'), groupsHandler.list);
router.get('/api/groups/:id', handleAuth0, enrichUserPermissions, requirePermission('groups.read'), groupsHandler.get);
router.post('/api/groups', handleAuth0, enrichUserPermissions, requirePermission('groups.write'), groupsHandler.create);
router.put('/api/groups/:id', handleAuth0, enrichUserPermissions, requirePermission('groups.write'), groupsHandler.update);
router.delete('/api/groups/:id', handleAuth0, enrichUserPermissions, requirePermission('groups.delete'), groupsHandler.delete);
router.post('/api/groups/:id/members', handleAuth0, enrichUserPermissions, requirePermission('users.manage_groups'), groupsHandler.addMembers);
router.delete('/api/groups/:id/members', handleAuth0, enrichUserPermissions, requirePermission('users.manage_groups'), groupsHandler.removeMembers);

// ICCID mapping routes
router.get('/api/iccid-mappings', handleAuth0, enrichUserPermissions, requirePermission('phones.read'), iccidMappingsHandler.list);
router.get('/api/iccid-mappings/:id', handleAuth0, enrichUserPermissions, requirePermission('phones.read'), iccidMappingsHandler.get);
router.get('/api/iccid-mappings/by-iccid/:iccid', handleAuth0, enrichUserPermissions, requirePermission('phones.read'), iccidMappingsHandler.getByIccid);
router.post('/api/iccid-mappings', handleAuth0, enrichUserPermissions, requirePermission('phones.write'), iccidMappingsHandler.create);
router.put('/api/iccid-mappings/:id', handleAuth0, enrichUserPermissions, requirePermission('phones.write'), iccidMappingsHandler.update);
router.delete('/api/iccid-mappings/:id', handleAuth0, enrichUserPermissions, requirePermission('phones.delete'), iccidMappingsHandler.delete);
router.post('/api/iccid-mappings/bulk', handleAuth0, enrichUserPermissions, requirePermission('phones.write'), iccidMappingsHandler.bulkImport);

// Control server routes - API Key auth
router.post('/api/control/messages', controlHandler.uploadMessages);
router.post('/api/control/phones', controlHandler.updatePhones);

// Server-Sent Events fallback route
router.get('/api/sse', (request) => sseHandler.connect(request, request.env));

// WebSocket route
router.get('/api/ws', async (request) => {
  console.log('WebSocket request received');
  const upgradeHeader = request.headers.get('Upgrade');
  console.log('Upgrade header:', upgradeHeader);
  
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    console.log('Invalid upgrade header, returning 426');
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  try {
    console.log('Getting Durable Object room');
    const roomId = request.env.WEBSOCKET_ROOMS.idFromName('global');
    const room = request.env.WEBSOCKET_ROOMS.get(roomId);
    console.log('Room ID:', roomId.toString());
    
    // Get the query string with the token
    const url = new URL(request.url);
    console.log('Original URL:', url.toString());
    
    // Forward the WebSocket upgrade request to the Durable Object
    // Use the original URL but change the path
    const durableObjectUrl = new URL(url);
    durableObjectUrl.pathname = '/websocket';
    console.log('Forwarding to Durable Object URL:', durableObjectUrl.toString());
    
    const response = await room.fetch(durableObjectUrl.toString(), request);
    console.log('Durable Object response status:', response.status);
    
    return response;
  } catch (error) {
    console.error('WebSocket route error:', error);
    console.error('Error stack:', error.stack);
    return new Response(JSON.stringify({ error: error.message, stack: error.stack }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

// API 404 handler
router.all('/api/*', () => new Response('Not Found', { status: 404 }));

// Serve frontend for all other routes
router.all('*', (request) => serveFrontend(request));

export default {
  async fetch(request, env, ctx) {
    try {
      // Add environment to request
      request.env = env;
      request.ctx = ctx;
      
      // Handle request - pass env and ctx to router
      const response = await router.handle(request, env, ctx);
      
      // If no route matched, return undefined
      if (!response) {
        return new Response('Not Found', { status: 404 });
      }
      
      // Add CORS headers
      return handleCORS(response);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
};

export { WebSocketRoom };