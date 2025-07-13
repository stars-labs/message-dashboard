// Working version without itty-router
import { handleCORS } from './middleware/cors';
import { controlHandler } from './handlers/control';

export default {
  async fetch(request, env, ctx) {
    console.log('Worker started - working version');
    
    // Add environment to request
    request.env = env;
    request.ctx = ctx;
    
    const url = new URL(request.url);
    const method = request.method;
    
    try {
      // Simple routing
      if (method === 'OPTIONS') {
        return handleCORS(new Response(null, { status: 204 }));
      }
      
      if (url.pathname === '/api/health') {
        return new Response('OK', { status: 200 });
      }
      
      // Control endpoints
      if (method === 'POST' && url.pathname === '/api/control/messages') {
        console.log('Control messages endpoint hit');
        const apiKey = request.headers.get('X-API-Key');
        console.log('API key present:', !!apiKey);
        const response = await controlHandler.uploadMessages(request);
        return handleCORS(response);
      }
      
      if (method === 'POST' && url.pathname === '/api/control/phones') {
        console.log('Control phones endpoint hit');
        const apiKey = request.headers.get('X-API-Key');
        console.log('API key present:', !!apiKey);
        console.log('API key length:', apiKey ? apiKey.length : 0);
        const response = await controlHandler.updatePhones(request);
        return handleCORS(response);
      }
      
      // Frontend placeholder
      if (!url.pathname.startsWith('/api/')) {
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>SMS Dashboard</title>
          </head>
          <body>
            <h1>SMS Dashboard</h1>
            <p>Worker is running. Frontend temporarily disabled.</p>
            <p>API endpoints:</p>
            <ul>
              <li>GET /api/health - Health check</li>
              <li>POST /api/control/messages - Upload messages (requires API key)</li>
              <li>POST /api/control/phones - Update phones (requires API key)</li>
            </ul>
          </body>
          </html>
        `, {
          headers: { 'Content-Type': 'text/html' }
        });
      }
      
      // 404 for unknown API routes
      return new Response('Not Found', { status: 404 });
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// Export empty WebSocketRoom to satisfy Durable Object binding
export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  
  async fetch(request) {
    return new Response('WebSocket temporarily disabled', { status: 503 });
  }
}