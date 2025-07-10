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
import { swaggerSpec } from './swagger-spec';

const router = Router();

// CORS preflight
router.options('*', handleCORS);

// Public API routes
router.get('/api/health', () => new Response('OK', { status: 200 }));

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

// API Documentation page
router.get('/api-docs', () => {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMS Dashboard API Documentation</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.9.0/swagger-ui.css">
    <style>
        body { margin: 0; padding: 0; }
        #swagger-ui { max-width: 1200px; margin: 0 auto; }
        .swagger-ui .topbar { display: none; }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js"></script>
    <script>
        window.onload = function() {
            window.ui = SwaggerUIBundle({
                url: "/swagger.json",
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: "StandaloneLayout"
            });
        };
    </script>
</body>
</html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    }
  });
});

// OpenAPI/Swagger documentation
router.options('/swagger.json', handleCORS);
router.get('/swagger.json', () => {
  return new Response(JSON.stringify(swaggerSpec, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
});


// Server-Sent Events for real-time updates
router.get('/api/sse', handleAuth0, enrichUserPermissions, sseHandler);

// API 404 handler
router.all('/api/*', () => new Response('Not Found', { status: 404 }));

// Serve frontend for all other routes
router.all('*', (request) => serveFrontend(request));

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      
      // Handle WebSocket endpoint directly (not through router)
      if (url.pathname === '/api/ws') {
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
          return new Response('Expected Upgrade: websocket', { status: 426 });
        }
        
        // Validate token
        const token = url.searchParams.get('token');
        if (!token) {
          return new Response('Unauthorized: Missing token', { status: 401 });
        }
        
        const sessionData = await env.SESSIONS.get(token);
        if (!sessionData) {
          return new Response('Unauthorized: Invalid token', { status: 401 });
        }
        
        // Parse session and create new request with user info
        const session = JSON.parse(sessionData);
        const headers = new Headers(request.headers);
        headers.set('X-User-Email', session.user?.email || '');
        headers.set('X-User-Id', session.user?.id || '');
        headers.set('X-Session-Valid', 'true');
        
        const durableObjectRequest = new Request(request.url, {
          method: request.method,
          headers: headers,
          body: request.body
        });
        
        // Get Durable Object
        const roomId = env.WEBSOCKET_ROOMS.idFromName('global');
        const room = env.WEBSOCKET_ROOMS.get(roomId);
        
        // Forward directly without changing the URL
        // The Durable Object will detect WebSocket by the Upgrade header
        return room.fetch(durableObjectRequest);
      }
      
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
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
};

export { WebSocketRoom };