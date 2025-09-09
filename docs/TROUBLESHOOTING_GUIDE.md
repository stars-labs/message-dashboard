# Troubleshooting Guide (v2.0)

## Table of Contents

1. [Device Count Discrepancies](#device-count-discrepancies)
2. [Memory Leaks in Zig Daemon](#memory-leaks-in-zig-daemon)
3. [Database Transaction Failures](#database-transaction-failures)
4. [Phantom Modems](#phantom-modems)
5. [API Response Errors](#api-response-errors)
6. [Migration Issues](#migration-issues)
7. [Performance Problems](#performance-problems)

## Device Count Discrepancies

### Symptom
- Frontend shows different device count than daemon reports
- Stats API returns inconsistent numbers

### Diagnosis
```bash
# Check all sources of device counts
npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_stats"

# Check daemon reported count
npx wrangler d1 execute sms-dashboard --remote --command="SELECT modem_count, last_heartbeat FROM daemon_health WHERE daemon_id = 'orange-pi-main'"

# Check actual table counts
npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM modems WHERE status = 'connected'"
```

### Solution
```javascript
// Use centralized device counting
import { getDeviceStats } from './utils/device-count.js';

const stats = await getDeviceStats(env.DB);
// stats.online_count is the single source of truth
```

## Memory Leaks in Zig Daemon

### Symptom
- Daemon memory usage grows over time
- System becomes unresponsive
- OOM killer terminates daemon

### Diagnosis
```bash
# Monitor daemon memory
ssh root@10.171.150.102 'ps aux | grep sms-dashboard'

# Check for allocation errors in logs
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -i "alloc\|memory"'
```

### Solution (Fixed in v2.0.0)
```zig
// Ensure all allocations are freed
pub fn getModemDetails(self: *ModemManager, modem_id: []const u8) !ModemDetails {
    const result = try std.process.Child.run(.{
        .allocator = self.allocator,
        .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
    });
    defer self.allocator.free(result.stdout);  // Critical!
    defer self.allocator.free(result.stderr);  // Critical!
    
    // Process and return duplicated strings
}
```

## Database Transaction Failures

### Symptom
- Batch updates partially complete
- Data inconsistency between tables
- "SQLITE_BUSY" errors

### Diagnosis
```bash
# Check for incomplete transactions
npx wrangler d1 execute sms-dashboard --remote --command="SELECT s.iccid FROM sims s WHERE NOT EXISTS (SELECT 1 FROM modems m WHERE m.equipment_id = s.current_modem_id)"

# Check for lock timeouts in logs
npx wrangler tail sms-dashboard | grep -i "busy\|locked"
```

### Solution
```javascript
// Use D1 batch API for transactions
const batch = phones.map(phone => ({
  statement: env.DB.prepare("INSERT OR REPLACE INTO modems..."),
  values: [phone.equipment_id, ...]
}));

const results = await env.DB.batch(batch);
```

## Phantom Modems

### Symptom
- Modems show as "connected" but haven't updated in minutes
- Device count higher than actual connected modems

### Diagnosis
```bash
# Find phantom modems
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT equipment_id, status, datetime(updated_at) as last_update 
FROM modems 
WHERE status = 'connected' 
AND datetime(updated_at) < datetime('now', '-60 seconds')"
```

### Solution
```bash
# Mark stale modems as disconnected
npx wrangler d1 execute sms-dashboard --remote --command="
UPDATE modems 
SET status = 'disconnected' 
WHERE status = 'connected' 
AND datetime(updated_at) < datetime('now', '-60 seconds')"

# Implement automatic cleanup in control handler
if (timeSinceUpdate > 60) {
  await updateModemStatus(modem_id, 'disconnected');
}
```

## API Response Errors

### Symptom
- Inconsistent API response formats
- Missing error details
- Frontend parsing errors

### Diagnosis
```javascript
// Check response format
curl -X GET https://sexy.qzz.io/api/stats | jq .

// Expected format:
{
  "success": true,
  "data": { ... }
}
```

### Solution
```javascript
// Always use standardized responses
import { success, error } from './utils/api-response.js';

// Correct
return success(data);
return error("Invalid request", 400);

// Incorrect
return new Response(JSON.stringify(data));
```

## Migration Issues

### Issue: Migration Validation Fails

```bash
# Run detailed validation
npx wrangler d1 execute sms-dashboard --remote --file=migrations/validate-migration.sql

# Common failures:
# - Orphaned SIMs: SIMs referencing non-existent modems
# - Duplicate ICCIDs: Multiple SIMs with same ICCID
# - Missing states: Modems without modem_state records
```

### Solution: Fix Orphaned SIMs
```sql
-- Set orphaned SIMs to inactive
UPDATE sims 
SET current_modem_id = NULL, status = 'inactive'
WHERE current_modem_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM modems m WHERE m.equipment_id = sims.current_modem_id
);
```

### Solution: Fix Duplicate ICCIDs
```sql
-- Keep only the most recent duplicate
DELETE FROM sims 
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM sims GROUP BY iccid
);
```

### Issue: Rollback Needed

```bash
# Execute rollback
npx wrangler d1 execute sms-dashboard --remote --file=migrations/rollback-to-phones.sql

# Verify rollback
npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM phones"
```

## Performance Problems

### Symptom
- Slow API responses
- Database query timeouts
- High CPU usage on Workers

### Diagnosis
```bash
# Check slow queries
npx wrangler tail sms-dashboard --format pretty | grep -E "duration|slow"

# Monitor database size
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT 
  (SELECT COUNT(*) FROM modems) as modems,
  (SELECT COUNT(*) FROM sims) as sims,
  (SELECT COUNT(*) FROM modem_state) as states,
  (SELECT COUNT(*) FROM messages) as messages"
```

### Solution: Add Missing Indexes
```sql
-- Ensure all indexes exist
CREATE INDEX IF NOT EXISTS idx_modems_status_updated ON modems(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sims_modem_status ON sims(current_modem_id, status);
CREATE INDEX IF NOT EXISTS idx_modem_state_updated ON modem_state(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
```

### Solution: Clean Old Data
```sql
-- Archive old modem states (keep last 24 hours)
DELETE FROM modem_state 
WHERE datetime(updated_at) < datetime('now', '-24 hours');

-- Clean up old daemon health records
DELETE FROM daemon_health 
WHERE datetime(last_heartbeat) < datetime('now', '-7 days');
```

## Emergency Procedures

### Complete System Reset

```bash
# 1. Stop daemon
ssh root@10.171.150.102 'systemctl stop sms-dashboard-daemon'

# 2. Reset all modem states
npx wrangler d1 execute sms-dashboard --remote --command="UPDATE modems SET status = 'disconnected'"
npx wrangler d1 execute sms-dashboard --remote --command="UPDATE sims SET status = 'inactive'"

# 3. Clear modem states
npx wrangler d1 execute sms-dashboard --remote --command="DELETE FROM modem_state"

# 4. Restart daemon
ssh root@10.171.150.102 'systemctl start sms-dashboard-daemon'

# 5. Monitor recovery
npx wrangler tail sms-dashboard --format pretty
```

### Database Corruption Recovery

```bash
# 1. Export all data
npx wrangler d1 execute sms-dashboard --remote --command=".dump" > full-backup.sql

# 2. Create new database
# (Contact Cloudflare support if needed)

# 3. Import data
npx wrangler d1 execute sms-dashboard --remote --file=full-backup.sql
```

## Monitoring Commands

```bash
# Real-time monitoring dashboard
watch -n 5 'npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_stats"'

# Daemon health check
watch -n 10 'npx wrangler d1 execute sms-dashboard --remote --command="SELECT daemon_id, status, health_status, modem_count, datetime(last_heartbeat) FROM daemon_health"'

# Error monitoring
npx wrangler tail sms-dashboard --format pretty | grep -i error
```