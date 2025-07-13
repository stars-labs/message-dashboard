// Working version with frontend restored
import { handleCORS } from './middleware/cors';
import { controlHandler } from './handlers/control';
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

// Control server routes - API Key auth
router.post('/api/control/messages', async (request) => {
  console.log('Control messages endpoint hit');
  try {
    return await controlHandler.uploadMessages(request);
  } catch (error) {
    console.error('Control messages error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

router.post('/api/control/phones', async (request) => {
  console.log('Control phones endpoint hit');
  try {
    return await controlHandler.updatePhones(request);
  } catch (error) {
    console.error('Control phones error:', error);
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
    console.log('Worker started - with frontend');
    
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
        return serveFrontend(request);
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
  }
};

// Export WebSocketRoom to satisfy Durable Object binding
export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  
  async fetch(request) {
    return new Response('WebSocket temporarily disabled', { status: 503 });
  }
}