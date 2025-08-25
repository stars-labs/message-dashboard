import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createDb } from './db/client';

// Import new Drizzle-based handlers
import { phonesHandler } from './handlers/phones';
import { messagesHandler } from './handlers/messages';
import { healthHandler } from './handlers/health';

// Import new Hono middleware
import { authMiddleware, requirePermission, enrichUserPermissions, apiKeyAuth } from './middleware/auth';

// Import handlers that still need migration
import { controlHandler } from '../server/handlers/control';
import { auth0Handler } from '../server/handlers/auth0';
import { statsHandler } from '../server/handlers/stats';
import { iccidMappingsHandler } from '../server/handlers/iccid-mappings';
import { updatesHandler } from '../server/handlers/updates';
import { aiHandler } from '../server/handlers/ai';
import { chatbotHandler } from '../server/handlers/chatbot';
import { chatbotStreamHandler } from '../server/handlers/chatbot-stream';
import { serveFrontend } from '../server/frontend-handler';
import { setupKeywordRoutes } from '../server/api/keywords';

// Type definitions for Cloudflare environment
type Bindings = {
  DB: D1Database;
  SESSIONS: KVNamespace;
  AI: any;
  VECTORIZE: any;
  // Auth0 secrets
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET: string;
  AUTH0_AUDIENCE?: string;
  // Other secrets
  API_KEY: string;
  // Environment variables
  ENVIRONMENT: string;
  DEFAULT_USER_GROUP: string;
  WORKER_URL: string;
  USE_AUTH0_ROLES: string;
  AUTH0_SMS_ROLE: string;
  AUTH0_ALTERNATIVE_SMS_ROLES: string;
  AUTH0_ROLE_NAMESPACE: string;
  AUTH0_ALLOW_NO_ROLES: string;
};

type Variables = {
  db: ReturnType<typeof createDb>;
  user?: any;
  userPermissions?: string[];
};

// Create Hono app with proper typing
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Global middleware
app.use('*', logger());

// CORS middleware with configuration
app.use('/api/*', cors({
  origin: (origin) => {
    // Allow all origins in development, restrict in production if needed
    return origin || '*';
  },
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 86400
}));

// Database middleware - inject Drizzle instance
app.use('*', async (c, next) => {
  const db = createDb(c.env.DB);
  c.set('db', db);
  await next();
});


// Helper to adapt old handlers to Hono
const adaptHandler = (handlerFn: Function) => {
  return async (c: any) => {
    const request = {
      url: c.req.url,
      method: c.req.method,
      headers: c.req.raw.headers,
      env: c.env,
      ctx: c.executionCtx,
      user: c.get('user'),
      userPermissions: c.get('userPermissions'),
      params: c.req.param(),
      json: async () => c.req.json(),
      text: async () => c.req.text()
    };
    
    const response = await handlerFn(request);
    return response;
  };
};

// ===== PUBLIC ROUTES =====

// Health check endpoints (using new Drizzle handlers)
app.get('/api/health', (c) => healthHandler.check(c));
app.get('/api/daemon/status', (c) => healthHandler.daemonStatus(c));
app.get('/api/health/metrics', (c) => healthHandler.metrics(c));

// Test endpoints
app.post('/api/test-stream', async (c) => {
  console.log('[Test] Stream test endpoint hit');
  return c.text('Stream test endpoint works');
});

app.get('/favicon.ico', () => new Response(null, { status: 204 }));

app.get('/test-html', (c) => {
  return c.html('<html><body>Test HTML</body></html>');
});

// ===== AUTH ROUTES =====

app.get('/login', adaptHandler(auth0Handler.login));
app.get('/callback', adaptHandler(auth0Handler.callback));
app.get('/logout', adaptHandler(auth0Handler.logout));
app.get('/api/auth/me', authMiddleware, adaptHandler(auth0Handler.me));

// ===== PROTECTED API ROUTES =====

// Polling updates
app.get('/api/updates', authMiddleware, adaptHandler(updatesHandler.poll));

// Phone management (using new Drizzle handlers)
app.get('/api/phones', 
  authMiddleware,
  enrichUserPermissions,
  requirePermission('phones.read'),
  (c) => phonesHandler.list(c)
);

app.get('/api/phones/:id',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('phones.read'),
  (c) => phonesHandler.get(c)
);

app.put('/api/phones/:id',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('phones.write'),
  (c) => phonesHandler.update(c)
);

app.delete('/api/phones/:id',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('phones.write'),
  (c) => phonesHandler.deletePhone(c)
);

// Message management (using new Drizzle handlers)
app.get('/api/messages',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('messages.read'),
  (c) => messagesHandler.list(c)
);

app.get('/api/messages/:id',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('messages.read'),
  (c) => messagesHandler.get(c)
);

app.post('/api/messages/send',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('messages.send'),
  (c) => messagesHandler.send(c)
);

app.delete('/api/messages/:id',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('messages.write'),
  (c) => messagesHandler.deleteMessage(c)
);

app.get('/api/messages/stats',
  authMiddleware,
  enrichUserPermissions,
  requirePermission('messages.read'),
  (c) => messagesHandler.stats(c)
);

// Stats endpoint (public for basic stats, authenticated for detailed)
app.get('/api/stats', adaptHandler(statsHandler.get));

// ICCID Mappings
const iccidGroup = app.basePath('/api/iccid-mappings')
  .use(authMiddleware)
  .use(enrichUserPermissions);

iccidGroup.get('/', requirePermission('phones.read'), adaptHandler(iccidMappingsHandler.list));
iccidGroup.get('/:id', requirePermission('phones.read'), adaptHandler(iccidMappingsHandler.get));
iccidGroup.get('/by-iccid/:iccid', requirePermission('phones.read'), adaptHandler(iccidMappingsHandler.getByIccid));
iccidGroup.post('/', requirePermission('phones.write'), adaptHandler(iccidMappingsHandler.create));
iccidGroup.put('/:id', requirePermission('phones.write'), adaptHandler(iccidMappingsHandler.update));
iccidGroup.delete('/:id', requirePermission('phones.write'), adaptHandler(iccidMappingsHandler.delete));
iccidGroup.post('/bulk', requirePermission('phones.write'), adaptHandler(iccidMappingsHandler.bulkImport));

// AI endpoints
const aiGroup = app.basePath('/api/ai')
  .use(authMiddleware)
  .use(enrichUserPermissions);

aiGroup.post('/extract-code', requirePermission('messages.read'), adaptHandler(aiHandler.extractCode));
aiGroup.post('/classify-message', requirePermission('messages.read'), adaptHandler(aiHandler.classifyMessage));
aiGroup.get('/search', requirePermission('messages.read'), adaptHandler(aiHandler.search));
aiGroup.get('/insights/:phone_id', requirePermission('messages.read'), adaptHandler(aiHandler.getInsights));
aiGroup.post('/suggest-reply', requirePermission('messages.send'), adaptHandler(aiHandler.suggestReply));
aiGroup.get('/verification-codes', requirePermission('messages.read'), adaptHandler(aiHandler.getVerificationCodes));
aiGroup.post('/generate-embedding', requirePermission('messages.read'), adaptHandler(aiHandler.generateEmbedding));
aiGroup.post('/analyze-keywords', requirePermission('keywords.read'), adaptHandler(aiHandler.analyzeKeywords));
aiGroup.post('/batch-process', requirePermission('messages.read'), adaptHandler(aiHandler.batchProcessMessages));

// Chat endpoints
aiGroup.post('/chat', requirePermission('messages.read'), adaptHandler(chatbotHandler.chat));
aiGroup.post('/chat/stream', requirePermission('messages.read'), adaptHandler(chatbotStreamHandler.chatStream));
aiGroup.get('/chat/conversations', requirePermission('messages.read'), adaptHandler(chatbotHandler.listConversations));
aiGroup.get('/chat/conversations/:conversation_id', requirePermission('messages.read'), adaptHandler(chatbotHandler.getHistory));

// ===== CONTROL API (API Key Auth) =====

const controlGroup = app.basePath('/api/control');

// Use API key authentication for all control endpoints
controlGroup.use('*', apiKeyAuth);

controlGroup.post('/messages', adaptHandler(controlHandler.uploadMessages));
controlGroup.post('/phones', adaptHandler(controlHandler.updatePhones));
controlGroup.post('/devices', adaptHandler(controlHandler.updateDevices));
controlGroup.delete('/messages', adaptHandler(controlHandler.clearMessages));
controlGroup.post('/cleanup-test-data', adaptHandler(controlHandler.cleanupTestData));
controlGroup.get('/pending-sms', adaptHandler(controlHandler.heartbeatAndGetPendingSMS));
controlGroup.post('/sms-result', adaptHandler(controlHandler.updateSMSResult));
controlGroup.post('/heartbeat', adaptHandler(controlHandler.heartbeat));

// ===== KEYWORD ROUTES =====
// Note: These will need to be migrated to Hono format
// For now, we'll create a compatibility wrapper
const keywordRouter = {
  get: (path: string, ...handlers: any[]) => {
    const fullPath = `/api/keywords${path === '/' ? '' : path}`;
    app.get(fullPath, authMiddleware, enrichUserPermissions, requirePermission('keywords.read'), ...handlers.map(adaptHandler));
  },
  post: (path: string, ...handlers: any[]) => {
    const fullPath = `/api/keywords${path === '/' ? '' : path}`;
    app.post(fullPath, authMiddleware, enrichUserPermissions, requirePermission('keywords.write'), ...handlers.map(adaptHandler));
  },
  put: (path: string, ...handlers: any[]) => {
    const fullPath = `/api/keywords${path === '/' ? '' : path}`;
    app.put(fullPath, authMiddleware, enrichUserPermissions, requirePermission('keywords.write'), ...handlers.map(adaptHandler));
  },
  delete: (path: string, ...handlers: any[]) => {
    const fullPath = `/api/keywords${path === '/' ? '' : path}`;
    app.delete(fullPath, authMiddleware, enrichUserPermissions, requirePermission('keywords.write'), ...handlers.map(adaptHandler));
  }
};

// Setup keyword routes using the compatibility wrapper
setupKeywordRoutes(keywordRouter as any);

// ===== FRONTEND SERVING =====

// Serve frontend for all other routes
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  
  // For the main app, check if user is authenticated
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const cookieHeader = c.req.header('Cookie');
    let token = null;
    
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').map((c: string) => c.trim());
      const authCookie = cookies.find((c: string) => c.startsWith('auth_token='));
      if (authCookie) {
        token = authCookie.split('=')[1];
      }
    }
    
    if (!token) {
      return c.redirect('/login', 302);
    }
    
    const sessionData = await c.env.SESSIONS.get(token);
    if (!sessionData) {
      return c.redirect('/login', 302);
    }
    
    const session = JSON.parse(sessionData);
    if (session.expires_at < Date.now()) {
      await c.env.SESSIONS.delete(token);
      return c.redirect('/login', 302);
    }
  }
  
  // Serve the frontend
  const request = {
    url: c.req.url,
    method: c.req.method,
    headers: c.req.raw.headers
  };
  return serveFrontend(request as any);
});

// Export for Cloudflare Workers
export default app;

// Stub WebSocketRoom class for migration purposes
export class WebSocketRoom {
  constructor(state: any, env: any) {}
  
  async fetch(request: Request) {
    return new Response('WebSocket support removed - migrated to SSE', { status: 410 });
  }
}