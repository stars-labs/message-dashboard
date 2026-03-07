# Database Migration Guide

## Backup & Restore

### Export production database
```bash
cd sms-dashboard
npx wrangler d1 export sms-dashboard --remote --output=dump.sql
```

### Import to local D1
```bash
npx wrangler d1 execute sms-dashboard --local --file=dump.sql
```

### Restore to production
```bash
npx wrangler d1 execute sms-dashboard --remote --file=dump.sql
```

## Running Migrations

Migrations are SQL files in `sms-dashboard/migrations/`. Apply them with:

```bash
# Local
npx wrangler d1 execute sms-dashboard --local --file=migrations/NNN_description.sql

# Production
npx wrangler d1 execute sms-dashboard --remote --file=migrations/NNN_description.sql
```

Each migration records its version in `schema_version`:
```sql
INSERT INTO schema_version (version, description, applied_at)
VALUES (N, 'description', CURRENT_TIMESTAMP);
```

### Check current version
```bash
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT * FROM schema_version ORDER BY version DESC LIMIT 5"
```

## Migrating to a New Cloudflare Account

1. Export database: `npx wrangler d1 export sms-dashboard --remote --output=dump.sql`
2. Create new D1: `npx wrangler d1 create sms-dashboard`
3. Update `wrangler.toml` with new `database_id` and `account_id`
4. Create KV namespace: `npx wrangler kv:namespace create SESSIONS`
5. Set secrets:
   ```bash
   npx wrangler secret put AUTH0_DOMAIN
   npx wrangler secret put AUTH0_CLIENT_ID
   npx wrangler secret put AUTH0_CLIENT_SECRET
   npx wrangler secret put API_KEY
   ```
6. Import database: `npx wrangler d1 execute sms-dashboard --remote --file=dump.sql`
7. Update Auth0 callback URLs for new domain
8. Deploy: `bun run deploy`

## Useful Queries

```bash
# Table list
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# Row counts
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT 'modems' as t, COUNT(*) as n FROM modems UNION ALL SELECT 'sims', COUNT(*) FROM sims UNION ALL SELECT 'messages', COUNT(*) FROM messages"

# Device view (what the UI sees)
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT iccid, number, carrier, status, signal FROM device_view LIMIT 10"
```
