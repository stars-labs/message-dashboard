import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';

/**
 * CORS middleware configuration
 */
export const corsMiddleware = cors({
  origin: true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposedHeaders: ['X-Total-Count'],
  maxAge: 86400
});