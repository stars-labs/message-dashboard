# Database Migrations

This directory contains SQL migration scripts for the SMS Dashboard D1 database.

## Migration History

### 056_enable_unicom_browser_balance.sql
- Promotes the validated China Unicom browser workflow from discovery to enabled.
- Makes eligible online Unicom SIMs available to fleet balance queries.
- Leaves browser execution serialized by the Balance Agent runner concurrency.

### 055_add_balance_runner_control_plane.sql
- Registers local balance-runner installations without storing runner secrets.
- Tracks per-capability heartbeat, health, current job, session, and concurrency.
- Supports legacy API-key scripts while the desktop agent adopts scoped Auth0 tokens.

### 054_add_unicom_web_balance_skill.sql
- Adds durable, leased China Unicom browser balance jobs and audit events.
- Enables the official random-password web profile for independent Unicom accounts.
- Stores no carrier cookies or passwords in D1.

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
bunx wrangler d1 execute sms-dashboard --local --file=migrations/[filename].sql
```

### Production
```bash
# Run migrations on production database
npm run db:migrate

# Or run a specific migration
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/[filename].sql

# Validate migration success
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/validate-migration.sql
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

### 019_fix_device_view_status_values.sql
- **Fixes device_view and device_stats status matching**
- Daemon writes `'active'` but views expected `'registered'` for `connection_status`
- Result: no device ever got status `'online'`, online count was always 0

### 051_add_sms_processing_session.sql
- Adds `messages.processing_session_id` for outbound SMS claims
- Lets a newly started daemon mark unfinished claims from an older daemon session as `unknown`
- Preserves at-most-once sending: uncertain messages are never automatically retried

### 057_scope_balance_jobs_to_auth0_subject.sql
- Adds `sim_balance_checks.requested_by_subject` for Dashboard-created balance work
- Routes Auth0 device runners only to jobs created by the same Auth0 subject
- Reserves a `NULL` owner for legacy API-key control jobs

## Device Status Mapping

### Raw Values (written by Rust daemon)

| Table | Field | Healthy Value | Unhealthy Value |
|-------|-------|---------------|-----------------|
| `modems` | `status` | `'active'` | `'disconnected'` |
| `sims` | `status` | `'active'` | `'inactive'` |
| `modem_state` | `connection_status` | `'active'` | — |

### Computed Status (`device_view.status`)

The `device_view` CASE expression combines the three tables into a single status:

| `device_view.status` | Condition |
|----------------------|-----------|
| `'online'` | modem active + SIM active + connection active/registered |
| `'registered'` | modem active + SIM active (no connection state) |
| `'sim-missing'` | modem active + no SIM card |
| `'offline'` | modem disconnected |
| `'error'` | anything else |

### Frontend Display

The client (`App.svelte` → `calculateOnlineDevices()`) counts devices as "online" when:
1. `status` is `'online'`, `'active'`, or `'registered'`
2. `updated_at` is within the last 5 minutes (proves daemon is still syncing)

## Rollback Procedures

If a migration needs to be rolled back:

1. Check current state:
```bash
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

2. Use appropriate rollback script (if provided)
3. Restore from backup if necessary

## Best Practices

1. **Always backup before major migrations**:
```bash
bunx wrangler d1 backup create sms-dashboard
```

2. **Test migrations locally first**:
```bash
npm run db:init
bunx wrangler d1 execute sms-dashboard --local --file=migrations/new_migration.sql
```

3. **Validate after migration**:
- Check table structures
- Verify data integrity
- Test application functionality

4. **Document all changes**:
- Update this README
- Add comments in migration files
- Update CLAUDE.md with schema changes
