import type { Config } from 'drizzle-kit';

// Determine if we're using Cloudflare D1 or local SQLite
const isCloudflare = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_DATABASE_ID;

const config: Config = isCloudflare ? {
  // Cloudflare D1 configuration
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  driver: 'd1',
  dbCredentials: {
    wranglerConfigPath: './wrangler.toml',
    dbName: 'sms-dashboard'
  }
} : {
  // Local SQLite configuration
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  driver: 'better-sqlite3',
  dbCredentials: {
    url: process.env.DATABASE_URL || './data/sqlite.db'
  }
};

export default config;