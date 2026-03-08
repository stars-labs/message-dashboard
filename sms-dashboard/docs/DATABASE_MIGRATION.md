# Database Migration Guide

## Backup & Restore

### Export production database
```bash
cd sms-dashboard
bunx wrangler d1 export sms-dashboard --remote --output=dump.sql
```

### Import to local D1
```bash
bunx wrangler d1 execute sms-dashboard --local --file=dump.sql
```

### Restore to production
```bash
bunx wrangler d1 execute sms-dashboard --remote --file=dump.sql
```

## Running Migrations

Migrations are SQL files in `sms-dashboard/migrations/`. Apply them with:

```bash
# Local
bunx wrangler d1 execute sms-dashboard --local --file=migrations/NNN_description.sql

# Production
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/NNN_description.sql
```

Each migration records its version in `schema_version`:
```sql
INSERT INTO schema_version (version, description, applied_at)
VALUES (N, 'description', CURRENT_TIMESTAMP);
```

### Check current version
```bash
bunx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT * FROM schema_version ORDER BY version DESC LIMIT 5"
```

## Migrating to a New Cloudflare Account

1. Export database: `bunx wrangler d1 export sms-dashboard --remote --output=dump.sql`
2. Create new D1: `bunx wrangler d1 create sms-dashboard`
3. Update `wrangler.toml` with new `database_id` and `account_id`
4. Create KV namespace: `bunx wrangler kv:namespace create SESSIONS`
5. Set secrets:
   ```bash
   bunx wrangler secret put AUTH0_DOMAIN
   bunx wrangler secret put AUTH0_CLIENT_ID
   bunx wrangler secret put AUTH0_CLIENT_SECRET
   bunx wrangler secret put API_KEY
   ```
6. Import database: `bunx wrangler d1 execute sms-dashboard --remote --file=dump.sql`
7. Update Auth0 callback URLs for new domain
8. Deploy: `bun run deploy`

## Useful Queries

```bash
# Table list
bunx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# Row counts
bunx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT 'modems' as t, COUNT(*) as n FROM modems UNION ALL SELECT 'sims', COUNT(*) FROM sims UNION ALL SELECT 'messages', COUNT(*) FROM messages"

# Device view (what the UI sees)
bunx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT iccid, number, carrier, status, signal FROM device_view LIMIT 10"
```
