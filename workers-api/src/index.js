import { Router } from 'itty-router';
import { handleAuth } from './middleware/auth';
import { handleCORS } from './middleware/cors';
import { phonesHandler } from './handlers/phones';
import { messagesHandler } from './handlers/messages';
import { statsHandler } from './handlers/stats';
import { controlHandler } from './handlers/control';
import { authHandler } from './handlers/auth';

const router = Router();

// CORS preflight
router.options('*', handleCORS);

// Public routes
router.get('/api/health', () => new Response('OK', { status: 200 }));

// Auth routes
router.get('/api/auth/login', authHandler.login);
router.get('/api/auth/callback', authHandler.callback);
router.get('/api/auth/logout', authHandler.logout);
router.get('/api/auth/me', handleAuth, authHandler.me);

// Protected routes - Web UI
router.get('/api/phones', handleAuth, phonesHandler.list);
router.get('/api/phones/:id', handleAuth, phonesHandler.get);
router.get('/api/messages', handleAuth, messagesHandler.list);
router.get('/api/messages/:id', handleAuth, messagesHandler.get);
router.post('/api/messages/send', handleAuth, messagesHandler.send);
router.get('/api/stats', handleAuth, statsHandler.get);

// Control server routes - API Key auth
router.post('/api/control/messages', controlHandler.uploadMessages);
router.post('/api/control/phones', controlHandler.updatePhones);

// 404 handler
router.all('*', () => new Response('Not Found', { status: 404 }));

export default {
  async fetch(request, env, ctx) {
    try {
      // Add environment to request
      request.env = env;
      request.ctx = ctx;
      
      // Handle request
      const response = await router.handle(request);
      
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