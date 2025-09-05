# Database Migrations

This directory contains SQL migration scripts for the SMS Dashboard D1 database.

## Migration History

### 001_initial_schema.sql
- Creates initial database tables
- Sets up basic structure for phones and messages

### 002_add_indexes.sql
- Adds performance indexes for common queries
- Optimizes phone and message lookups

### 003_add_ai_tables.sql
- Adds AI insights and embeddings support
- Creates tables for message classification and verification codes

### 004_add_keywords.sql
- Adds keyword tagging system
- Creates tables for keyword configuration and message tags

### 005_normalize_database.sql
- Initial normalization to separate modems and SIMs
- Creates `modems`, `sims`, `modem_state`, and `daemon_health` tables
- Adds `device_view` for backward compatibility

### 006a_prepare_messages_fix_v2.sql
- **Normalizes messages table to 3NF compliance**
- Removes redundant columns (`phone_id`, `sim_iccid`, `modem_id`)
- Migrates data to normalized structure
- Adds foreign key constraint to `sims.iccid`

### 007_add_user_overrides.sql
- **Implements user override pattern in 3NF**
- Adds override fields to `sims` table:
  - `user_phone_number`
  - `user_carrier`
  - `user_country_code`
  - `user_notes`
  - `user_override_enabled`
- Migrates data from deprecated `iccid_mappings` table
- Updates `device_view` to use overrides when enabled

### 008_cleanup_deprecated_tables.sql
- **Removes deprecated tables after successful migration**
- Drops `messages_old_backup` (1001 rows)
- Drops `iccid_mappings_deprecated` (32 rows)
- Reduces database size by 79% (5.31MB → 1.09MB)

## Running Migrations

### Local Development
```bash
# Initialize local database
npm run db:init

# Run a specific migration locally
npx wrangler d1 execute sms-dashboard --local --file=migrations/[filename].sql
```

### Production
```bash
# Run migrations on production database
npm run db:migrate

# Or run a specific migration
npx wrangler d1 execute sms-dashboard --remote --file=migrations/[filename].sql

# Validate migration success
npx wrangler d1 execute sms-dashboard --remote --file=migrations/validate-migration.sql
```

## Database Schema (Current - v2.1)

### Normalized Structure (3NF Compliant)

```sql
-- Hardware devices
modems (
  equipment_id PRIMARY KEY,  -- IMEI
  manufacturer,
  model,
  firmware_revision,
  status,
  ...
)

-- SIM cards with user overrides
sims (
  iccid PRIMARY KEY,
  phone_number,           -- System value from mmcli
  carrier,
  country_code,
  user_phone_number,      -- User override
  user_carrier,           -- User override
  user_country_code,      -- User override
  user_notes,             -- User notes
  user_override_enabled,  -- Enable overrides
  current_modem_id,       -- FK to modems
  ...
)

-- Real-time modem state
modem_state (
  modem_id PRIMARY KEY,   -- FK to modems
  modem_index,
  usb_port,
  signal_percent,
  connection_status,
  ...
)

-- SMS messages
messages (
  id PRIMARY KEY,
  phone_iccid,           -- FK to sims.iccid
  phone_number,
  content,
  timestamp,
  type,
  ...
)

-- Backward compatibility view
device_view (
  -- Combines all tables
  -- Uses user overrides when enabled
  -- Maintains legacy field names
)
```

## Rollback Procedures

If a migration needs to be rolled back:

1. Check current state:
```bash
npx wrangler d1 execute sms-dashboard --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

2. Use appropriate rollback script (if provided)
3. Restore from backup if necessary

## Best Practices

1. **Always backup before major migrations**:
```bash
npx wrangler d1 backup create sms-dashboard
```

2. **Test migrations locally first**:
```bash
npm run db:init
npx wrangler d1 execute sms-dashboard --local --file=migrations/new_migration.sql
```

3. **Validate after migration**:
- Check table structures
- Verify data integrity
- Test application functionality

4. **Document all changes**:
- Update this README
- Add comments in migration files
- Update CLAUDE.md with schema changes