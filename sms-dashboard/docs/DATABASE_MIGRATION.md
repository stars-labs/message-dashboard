# Database Migration Guide

This guide explains how to backup and restore your Cloudflare D1 database when migrating to a new Cloudflare account.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Backup Process](#backup-process)
- [Migration Steps](#migration-steps)
- [Restore Process](#restore-process)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)

## Prerequisites

1. **Wrangler CLI** installed and configured
2. **Node.js** (v16 or higher)
3. Access to both old and new Cloudflare accounts
4. Sufficient disk space for backups (estimate: 2-3x your database size)

## Backup Process

### 1. Automatic Backup (Recommended)

Use the provided backup script:

```bash
cd sms-dashboard
node scripts/backup-database.js
```

This will:
- Create a timestamped backup folder in `sms-dashboard/backups/`
- Export all tables with their schemas and indexes
- Generate three backup formats:
  - `complete-backup.json` - All data in single JSON file
  - `backup.sql` - SQL dump for easy restore
  - Individual `[table_name].json` files

### 2. Manual Backup

If you prefer manual backup:

```bash
# Export entire database
npx wrangler d1 export sms-dashboard --output=backup.sql --remote

# Or export specific tables
npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM messages" > messages.json
```

### 3. Backup Verification

Check your backup:
```bash
ls -la sms-dashboard/backups/backup-*/
# Should show: metadata.json, complete-backup.json, backup.sql, and individual table files
```

## Migration Steps

### 1. Setup New Cloudflare Account

1. Create new Cloudflare account
2. Add your domain (if migrating domain as well)
3. Install Wrangler and authenticate:
```bash
npx wrangler login
```

### 2. Create New D1 Database

```bash
# Create new database
npx wrangler d1 create sms-dashboard

# Note the database_id from the output
# Update wrangler.toml with new database_id
```

### 3. Update Configuration

Edit `wrangler.toml`:
```toml
account_id = "YOUR_NEW_ACCOUNT_ID"

[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "YOUR_NEW_DATABASE_ID"
```

### 4. Create Other Resources

```bash
# Create KV namespace for sessions
npx wrangler kv:namespace create SESSIONS

# Create Vectorize index for embeddings
npx wrangler vectorize create sms-messages --dimensions=768 --metric=cosine

# Update wrangler.toml with new IDs
```

### 5. Set Secrets

```bash
# Set all required secrets
npx wrangler secret put AUTH0_DOMAIN
npx wrangler secret put AUTH0_CLIENT_ID
npx wrangler secret put AUTH0_CLIENT_SECRET
npx wrangler secret put API_KEY
```

## Restore Process

### 1. Automatic Restore (Recommended)

```bash
cd sms-dashboard

# Restore from latest backup
node scripts/restore-database.js

# Or restore from specific backup
node scripts/restore-database.js backup-2025-08-16T10-30-45
```

The script will:
1. Show backup information
2. Ask for confirmation
3. Restore all tables with data
4. Verify row counts

### 2. Manual Restore

```bash
# Using SQL dump
npx wrangler d1 execute sms-dashboard --file=backups/backup-*/backup.sql --remote

# Or import JSON data
npx wrangler d1 import sms-dashboard --file=backup.json --remote
```

### 3. Restore Vectorize Data

After database restore, rebuild vector embeddings:

```bash
# Create metadata indexes
npx wrangler vectorize create-metadata-index sms-messages --property-name=phone_id --type=string
npx wrangler vectorize create-metadata-index sms-messages --property-name=type --type=string

# Trigger batch processing to recreate embeddings
curl -X POST https://your-domain.com/api/ai/batch-process \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 100}'
```

## Verification

### 1. Check Database

```bash
# Verify tables exist
npx wrangler d1 execute sms-dashboard --remote --command="SELECT name FROM sqlite_master WHERE type='table'"

# Check row counts
npx wrangler d1 execute sms-dashboard --remote --command="SELECT 'messages' as table_name, COUNT(*) as count FROM messages"
```

### 2. Test Application

1. Deploy the worker:
```bash
npm run deploy
```

2. Test key endpoints:
```bash
# Health check
curl https://your-domain.com/api/health

# Check phones
curl https://your-domain.com/api/phones -H "Authorization: Bearer TOKEN"
```

### 3. Verify Features

- [ ] Login/Authentication works
- [ ] Phone list loads correctly
- [ ] Messages display properly
- [ ] Search functionality works
- [ ] SMS sending functions
- [ ] ICCID mappings are intact

## Troubleshooting

### Common Issues

#### 1. "Database not found" error
- Ensure database_id in wrangler.toml matches the new database
- Check you're logged into the correct Cloudflare account

#### 2. Missing data after restore
- Check backup completeness: `node scripts/backup-database.js`
- Verify all tables were restored
- Check for SQL errors during restore

#### 3. Authentication issues
- Verify all secrets are set: `npx wrangler secret list`
- Update Auth0 callback URLs for new domain
- Check CORS settings if domain changed

#### 4. Vector search not working
- Recreate Vectorize index
- Run batch processing to regenerate embeddings
- Verify metadata indexes are created

### Rollback Plan

If migration fails:
1. Keep old account active until verified
2. Have DNS records ready to switch back
3. Keep backup of old wrangler.toml
4. Document all configuration changes

## Best Practices

### Regular Backups

Add to crontab for automatic backups:
```bash
# Daily backup at 2 AM
0 2 * * * cd /path/to/sms-dashboard && node scripts/backup-database.js
```

### Backup Retention

Clean old backups:
```bash
# Keep only last 30 days of backups
find sms-dashboard/backups -type d -name "backup-*" -mtime +30 -exec rm -rf {} \;
```

### Testing

Always test restore process:
1. Create test database: `npx wrangler d1 create sms-dashboard-test`
2. Restore to test database first
3. Verify all functionality
4. Then restore to production

## Migration Checklist

- [ ] Backup current database
- [ ] Verify backup integrity
- [ ] Create new Cloudflare account
- [ ] Setup new D1 database
- [ ] Update wrangler.toml
- [ ] Create KV namespaces
- [ ] Create Vectorize index
- [ ] Set all secrets
- [ ] Restore database
- [ ] Rebuild vector embeddings
- [ ] Deploy worker
- [ ] Update DNS (if needed)
- [ ] Test all functionality
- [ ] Monitor for 24 hours
- [ ] Decommission old account

## Support

For issues or questions:
1. Check logs: `npx wrangler tail sms-dashboard`
2. Verify configuration: `npx wrangler whoami`
3. Test locally first: `npx wrangler dev --local`

## Backup File Formats

### metadata.json
Contains backup metadata including timestamp, table list, and row counts.

### complete-backup.json
Single JSON file with all tables, schemas, and data. Best for programmatic restore.

### backup.sql
Standard SQL dump file. Compatible with most SQL tools. Fastest restore method.

### [table_name].json
Individual table backups. Useful for selective restore.

---

**Important**: Always test the migration process in a development environment first!