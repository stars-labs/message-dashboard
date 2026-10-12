import { Elysia } from 'elysia';
import { sql } from 'drizzle-orm';
import { phones } from '../db/schema';

export const healthRoutes = new Elysia({ prefix: '/health' })
  .get('/', async ({ db }) => {
    try {
      // Test database connection by counting phones
      const result = await db.select({ count: sql<number>`COUNT(*)` })
        .from(phones)
        .limit(1);
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected',
        phones_count: result[0]?.count || 0
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: (error as Error).message
      };
    }
  });