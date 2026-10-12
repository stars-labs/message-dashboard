import { Elysia } from 'elysia';
import { corsMiddleware } from './middleware/cors';
import { authMiddleware } from './middleware/auth';
import { createDatabase, isCloudflareWorkers } from './services/database';
import { createSessionStore } from './services/session';
import { createAIService } from './services/ai';
import { controlRoutes } from './routes/control';
import { phonesRoutes } from './routes/phones';
import { messagesRoutes } from './routes/messages';
import { statsRoutes } from './routes/stats';
import { healthRoutes } from './routes/health';
import { FRONTEND_ASSETS } from './frontend-assets';


/**
 * Create the Elysia application
 */
function createApp() {
  const app = new Elysia({
    // Disable AOT completely for Cloudflare Workers compatibility
    aot: false
  })
    // Global middleware
    .use(corsMiddleware)
    
    // Derive context with services
    .derive(({ request }) => {
      // Get environment from global context (set by CF worker) or process.env
      const environment = (globalThis as any).__env || (request as any).env || process.env;
      
      // Create services
      const db = createDatabase(environment);
      const sessions = createSessionStore(environment);
      const ai = createAIService(environment);
      
      return {
        env: environment,
        db,
        sessions,
        ai
      };
    })
    
    // Auth middleware (adds user to context)
    .use(authMiddleware)
    
    // Serve frontend HTML
    .get('/', () => {
      const indexHtml = FRONTEND_ASSETS['index.html'];
      if (!indexHtml) {
        return new Response('Frontend not found', { status: 404 });
      }
      
      return new Response(indexHtml.content, {
        headers: { 
          'Content-Type': indexHtml.type || 'text/html',
          'Cache-Control': 'max-age=0'
        }
      });
    })
    
    // Serve static assets
    .get('/assets/*', ({ params }) => {
      const assetPath = `assets/${params['*']}`;
      const asset = FRONTEND_ASSETS[assetPath];
      
      if (!asset) {
        return new Response('Asset not found', { status: 404 });
      }
      
      const headers = {
        'Content-Type': asset.type || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000' // 1 year cache for assets
      };
      
      if (asset.encoding === 'base64') {
        const buffer = Uint8Array.from(atob(asset.content), c => c.charCodeAt(0));
        return new Response(buffer, { headers });
      }
      
      return new Response(asset.content, { headers });
    })
    
    // API Routes - Register directly instead of using plugins
    .get('/api/test', () => ({ message: 'API is working' }))
    
    // Health endpoint
    .get('/api/health', async ({ db }) => {
      try {
        // Import needed for the query
        const { sql } = await import('drizzle-orm');
        
        // Simple test query to check DB connection
        const result = await db.all(sql`SELECT 1 as test`);
        
        return {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          database: 'connected',
          test: result[0]?.test === 1
        };
      } catch (error) {
        return {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          database: 'disconnected',
          error: (error as Error).message
        };
      }
    })
    
    // Get all phones/SIMs 
    .get('/api/phones', async ({ db }) => {
      try {
        const { sql } = await import('drizzle-orm');
        
        // Get all phones from device_view
        const result = await db.all(sql`
          SELECT * FROM device_view 
          ORDER BY updated_at DESC
        `);
        
        return result;
      } catch (error) {
        return { error: (error as Error).message };
      }
    })
    
    // Get all messages
    .get('/api/messages', async ({ db, query }) => {
      try {
        const { sql } = await import('drizzle-orm');
        const limit = query.limit ? parseInt(query.limit) : 100;
        const offset = query.offset ? parseInt(query.offset) : 0;
        
        const result = await db.all(sql`
          SELECT * FROM messages 
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `);
        
        return result;
      } catch (error) {
        return { error: (error as Error).message };
      }
    })
    
    // Get stats
    .get('/api/stats', async ({ db, query }) => {
      try {
        const { sql } = await import('drizzle-orm');
        const range = query.range || '24h';
        
        // Calculate time threshold based on range
        let timeThreshold;
        const now = new Date();
        switch (range) {
          case '1h':
            timeThreshold = new Date(now.getTime() - 60 * 60 * 1000);
            break;
          case '24h':
            timeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            break;
          case '7d':
            timeThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
          case '30d':
            timeThreshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
          default:
            timeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        }
        
        const stats = await db.get(sql`
          SELECT 
            (SELECT COUNT(*) FROM device_view WHERE status = 'connected') as connected_devices,
            (SELECT COUNT(*) FROM device_view) as total_devices,
            (SELECT COUNT(*) FROM messages WHERE created_at >= ${timeThreshold.toISOString()}) as messages_in_period,
            (SELECT COUNT(*) FROM messages) as total_messages
        `);
        
        return stats;
      } catch (error) {
        return { error: (error as Error).message };
      }
    })
    
    // Control endpoints for Orange Pi daemon
    .post('/api/control/phones', async ({ db, body, headers }) => {
      try {
        // Check API key
        const apiKey = headers['x-api-key'];
        if (apiKey !== (globalThis as any).__env?.API_KEY) {
          return { error: 'Unauthorized' };
        }
        
        const { sql } = await import('drizzle-orm');
        const phones = Array.isArray(body) ? body : [body];
        
        // Process phone updates
        for (const phone of phones) {
          if (!phone.id) continue;
          
          // Update or insert phone data
          await db.run(sql`
            INSERT OR REPLACE INTO device_view 
            (id, operator, signal_percent, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            phone.id,
            phone.operator || 'Unknown',
            phone.signal_percent || 0,
            phone.status || 'unknown',
            phone.created_at || new Date().toISOString(),
            new Date().toISOString()
          ]);
        }
        
        return { success: true, processed: phones.length };
      } catch (error) {
        return { error: (error as Error).message };
      }
    })
    
    .post('/api/control/messages', async ({ db, body, headers }) => {
      try {
        // Check API key
        const apiKey = headers['x-api-key'];
        if (apiKey !== (globalThis as any).__env?.API_KEY) {
          return { error: 'Unauthorized' };
        }
        
        const { sql } = await import('drizzle-orm');
        const messages = Array.isArray(body) ? body : [body];
        
        // Process message uploads
        for (const message of messages) {
          if (!message.id || !message.phone_id) continue;
          
          // Insert message
          await db.run(sql`
            INSERT OR IGNORE INTO messages 
            (id, phone_id, content, sender, created_at)
            VALUES (?, ?, ?, ?, ?)
          `, [
            message.id,
            message.phone_id,
            message.content || '',
            message.sender || 'Unknown',
            message.created_at || new Date().toISOString()
          ]);
        }
        
        return { success: true, processed: messages.length };
      } catch (error) {
        return { error: (error as Error).message };
      }
    })
    
    .get('/api/control/pending-sms', async ({ db, headers }) => {
      try {
        // Check API key
        const apiKey = headers['x-api-key'];
        if (apiKey !== (globalThis as any).__env?.API_KEY) {
          return { error: 'Unauthorized' };
        }
        
        // Return empty for now - implement if needed
        return { pending_messages: [] };
      } catch (error) {
        return { error: (error as Error).message };
      }
    })
    
    
    // Error handling
    .onError(({ code, error, set }) => {
      console.error(`[Error] ${code}:`, error);
      
      if (code === 'VALIDATION') {
        set.status = 400;
        return {
          error: 'Validation error',
          message: error.message
        };
      }
      
      if (code === 'NOT_FOUND') {
        set.status = 404;
        return {
          error: 'Not found'
        };
      }
      
      set.status = 500;
      return {
        error: 'Internal server error',
        message: error.message
      };
    });
  
  return app;
}

// Create the app instance
const app = createApp();

// For Node.js/Bun (VPS deployment)
if (!isCloudflareWorkers()) {
  const port = process.env.PORT || 3000;
  app.listen(port);
  console.log(`🦊 ElysiaJS server running at http://localhost:${port}`);
}

// For Cloudflare Workers
export default !isCloudflareWorkers() ? {} : {
  async fetch(request: Request, env: any, ctx: any) {
    // Store env in global context for the app to access
    (globalThis as any).__env = env;
    (globalThis as any).__ctx = ctx;
    
    // Handle the request
    return app.handle(request);
  }
};