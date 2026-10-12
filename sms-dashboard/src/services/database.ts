import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

// Type for our database instance  
export type DrizzleDB = any; // Use any to support both D1 and SQLite

/**
 * Creates a database connection based on the environment
 * For Cloudflare Workers, uses D1
 * For local development, must use wrangler dev --local
 */
export function createDatabase(env?: any): DrizzleDB {
  // Cloudflare D1 (production or wrangler dev)
  if (env?.DB) {
    console.log('[Database] Using Cloudflare D1 database');
    return drizzleD1(env.DB, { schema });
  }
  
  // No database available
  throw new Error('Database not configured. Use wrangler dev --local for local development or deploy to Cloudflare Workers.');
}

/**
 * Helper to detect if we're running in Cloudflare Workers
 */
export function isCloudflareWorkers(): boolean {
  return typeof globalThis.WebSocketPair !== 'undefined';
}