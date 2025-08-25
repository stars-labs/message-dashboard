import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

// Export function to create database client with D1 binding
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

// Type export for the database client
export type Database = ReturnType<typeof createDb>;