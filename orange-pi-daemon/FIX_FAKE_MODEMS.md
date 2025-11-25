# Action Plan: Fix Fake MODEM_ Entries

## Executive Summary

**Problem**: Daemon creates fake modem entries (MODEM_35, MODEM_17, etc.) when SIM cards are changed, corrupting the database.

**Root Cause**: Defensive fallback logic that creates fake equipment_id instead of failing when IMEI is unavailable.

**Solution**: Remove fallback logic, fail fast when IMEI unavailable, skip modem for current cycle.

**Timeline**:
- Code fix: 2 hours
- Testing: 1 hour
- Deployment: 30 minutes
- Database cleanup: 1 hour
- Total: ~5 hours

---

## Phase 1: Immediate Code Fix (Prevent Future Corruption)

### Files to Modify

1. **`src/modem_manager.rs`** (Line 88-98)
2. **`src/worker_pool.rs`** (Line 238-247)
3. **`src/main.rs`** (Line 136-141)

### Changes Required

#### 1. modem_manager.rs

```rust
// BEFORE (creates fake IDs):
pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
    let details = self.dbus_client.get_device_details(modem_id).await?;

    let imei = if details.imei.is_empty() {
        format!("MODEM_{}", modem_id)  // ❌ BAD
    } else {
        details.imei
    };

    Ok((imei, details.manufacturer, details.model, details.firmware_version, details.hardware_revision))
}

// AFTER (fails fast):
pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
    let details = self.dbus_client.get_device_details(modem_id).await?;

    // Fail instead of creating fake IMEI
    if details.imei.is_empty() {
        return Err(anyhow!("Modem {} has no IMEI - likely in transitional state during SIM swap", modem_id));
    }

    Ok((details.imei, details.manufacturer, details.model, details.firmware_version, details.hardware_revision))
}
```

#### 2. worker_pool.rs

```rust
// BEFORE (uses fallback):
let (equipment_id, manufacturer, model, firmware, hardware) = modem_manager
    .get_device_details(&modem_id)
    .await
    .unwrap_or_else(|_| (
        format!("MODEM_{}", modem_id),  // ❌ BAD
        None,
        None,
        None,
        None,
    ));

// AFTER (propagates error):
let (equipment_id, manufacturer, model, firmware, hardware) = modem_manager
    .get_device_details(&modem_id)
    .await
    .context("Failed to get device details with valid IMEI")?;

// Add validation
if equipment_id.starts_with("MODEM_") || equipment_id.is_empty() {
    return Err(anyhow!("Invalid equipment_id format: {}", equipment_id));
}
```

#### 3. main.rs

```rust
// BEFORE (shows all errors equally):
if let Some(error) = &result.error {
    if error != "No SIM card" && error != "Timeout" {
        warn!("⚠️  Modem {} error: {}", result.modem_id, error);
    }
}

// AFTER (distinguishes transient errors):
if let Some(error) = &result.error {
    // Transient errors (expected during SIM swaps)
    if error.contains("no IMEI") || error.contains("transitional state") {
        debug!("⏳ Modem {} temporarily unavailable: {}", result.modem_id, error);
    }
    // Expected states
    else if error == "No SIM card" || error == "Timeout" {
        debug!("⏭️  Modem {} skipped: {}", result.modem_id, error);
    }
    // Actual errors
    else {
        warn!("⚠️  Modem {} error: {}", result.modem_id, error);
    }
}
```

### Testing the Fix

```bash
# 1. Build with changes
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/orange-pi-daemon
cargo build --release

# 2. Run tests
cargo test

# 3. Local test with debug logging
RUST_LOG=debug cargo run

# 4. Check for MODEM_ pattern in output
# Should see: "Modem X temporarily unavailable: no IMEI"
# Should NOT see: equipment_id with MODEM_ prefix
```

### Deployment

```bash
# 1. Build the daemon
nix build .#sms-daemon

# 2. Deploy to Orange Pi
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@203.116.95.146 \
    --build-host root@203.116.95.146 \
    --impure

# 3. Verify deployment
ssh root@203.116.95.146 'systemctl status sms-daemon'
ssh root@203.116.95.146 'journalctl -u sms-daemon -f --since "5 minutes ago"'

# 4. Monitor for 30 minutes
# Watch for "temporarily unavailable" messages (expected)
# Watch for MODEM_ equipment_id in uploads (should be ZERO)
```

---

## Phase 2: Database Analysis (Understand Current State)

### Run Analysis Script

```bash
# 1. Execute analysis on remote database
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard
npx wrangler d1 execute sms-dashboard --remote --file=sql/analyze-fake-modems.sql > fake-modem-analysis.txt

# 2. Review output
cat fake-modem-analysis.txt

# Look for:
# - Number of fake MODEM_ entries
# - Number of affected SIMs
# - Potential real modem matches
# - Temporal correlation data
```

### Key Questions to Answer

1. **How many fake modems exist?**
   - Look at "FAKE MODEM ENTRIES" section

2. **Which SIMs are affected?**
   - Check "SIM TO FAKE MODEM MAPPINGS" section

3. **Can we auto-correct the mappings?**
   - Review "POTENTIAL REAL MODEM MATCHES" section
   - High confidence if USB port matches OR time_diff < 60 seconds

4. **When did corruption start?**
   - Check "FAKE MODEM CREATION TIMELINE" section
   - Helps identify if it's ongoing or historical

### Expected Output Example

```
=== SUMMARY STATISTICS ===
fake_modems_count: 23
real_modems_count: 94
sims_with_fake_modems: 18
sims_with_real_modems: 76
sims_without_modem: 3
fake_history_entries: 45
fake_percentage: 19.66
```

---

## Phase 3: Database Cleanup (Remove Corruption)

### Pre-Cleanup Checklist

- [ ] Code fix deployed and running for at least 30 minutes
- [ ] Analysis script run and reviewed
- [ ] Backup created: `npx wrangler d1 backup sms-dashboard`
- [ ] Stakeholders notified of maintenance window

### Execute Cleanup

```bash
# 1. Create database backup
npx wrangler d1 backup sms-dashboard

# 2. Run cleanup script (DRY RUN - check what will happen)
npx wrangler d1 execute sms-dashboard --remote --file=sql/cleanup-fake-modems.sql > cleanup-result.txt

# 3. Review cleanup-result.txt carefully
# Check:
# - Number of records to be archived
# - Number of SIMs to be remapped
# - Confidence levels of mappings

# 4. If satisfied, the script has already executed (it's not a dry-run)
# 5. Verify cleanup
npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) as fake_count FROM modems WHERE equipment_id LIKE 'MODEM_%'"

# Should return: fake_count = 0
```

### Post-Cleanup Verification

```bash
# 1. Check no fake modems remain
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT COUNT(*) as fake_modems FROM modems WHERE equipment_id LIKE 'MODEM_%'
UNION ALL
SELECT COUNT(*) as fake_sims FROM sims WHERE current_modem_id LIKE 'MODEM_%'
"

# 2. Check archive tables
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT COUNT(*) as archived_modems FROM modems_archive_fake
"

# 3. Review correction methods
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT correction_method, COUNT(*) FROM sims_archive_fake_relationships GROUP BY correction_method
"

# 4. Check for orphaned SIMs
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT COUNT(*) FROM sims s
WHERE s.current_modem_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM modems m WHERE m.equipment_id = s.current_modem_id)
"
```

---

## Phase 4: Server-Side Hardening (Defense in Depth)

### Add Validation to control.js

Location: `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard/server/handlers/control.js`

#### Changes to updateDevices() function (Line 58-94)

```javascript
// BEFORE:
for (const modem of modems) {
    if (!modem.equipment_id) {
        console.warn('[control.js] Skipping modem without equipment_id');
        continue;
    }
    // ... insert modem

// AFTER:
for (const modem of modems) {
    // Validate equipment_id is not empty
    if (!modem.equipment_id) {
        console.warn('[control.js] Skipping modem without equipment_id');
        continue;
    }

    // Reject fake equipment_id formats
    if (modem.equipment_id.startsWith('MODEM_') || modem.equipment_id.startsWith('SIM_')) {
        console.error(`[control.js] REJECTED fake equipment_id: ${modem.equipment_id} - daemon bug detected!`);
        continue;
    }

    // Require minimum hardware information (at least manufacturer OR model)
    if (!modem.manufacturer && !modem.model) {
        console.error(`[control.js] REJECTED modem ${modem.equipment_id} with no hardware info - likely fake`);
        continue;
    }

    // ... insert modem
```

#### Add Metric Logging

```javascript
// After the modem processing loop, add:
let rejectedFakeIds = 0;
let rejectedNoHardware = 0;

// Then increment these counters in the validation blocks above
// And log at end:
if (rejectedFakeIds > 0 || rejectedNoHardware > 0) {
    console.error(`[control.js] ⚠️  DATA QUALITY ALERT: Rejected ${rejectedFakeIds} fake IDs, ${rejectedNoHardware} modems without hardware info`);
}
```

### Deploy Server Changes

```bash
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard
bun run deploy

# Verify deployment
npx wrangler tail sms-dashboard --format pretty
# Watch for "REJECTED fake equipment_id" messages (should be zero after daemon fix)
```

---

## Phase 5: Monitoring & Prevention

### Add Database Constraint

```sql
-- Add check constraint to prevent future fake IDs
-- Run this after cleanup is complete
npx wrangler d1 execute sms-dashboard --remote --command="
-- Note: SQLite doesn't support ALTER TABLE ADD CONSTRAINT for CHECK
-- So we need to create trigger instead

DROP TRIGGER IF EXISTS prevent_fake_modem_ids;

CREATE TRIGGER prevent_fake_modem_ids
BEFORE INSERT ON modems
WHEN NEW.equipment_id LIKE 'MODEM_%' OR NEW.equipment_id LIKE 'SIM_%'
BEGIN
    SELECT RAISE(ABORT, 'Invalid equipment_id format - must be real IMEI');
END;
"
```

### Create Monitoring Query

```sql
-- Save this as sql/monitor-data-quality.sql
-- Run hourly via cron

SELECT
    'Data Quality Check' as report,
    CURRENT_TIMESTAMP as check_time,
    (SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%' OR equipment_id LIKE 'SIM_%') as fake_modems,
    (SELECT COUNT(*) FROM sims WHERE current_modem_id LIKE 'MODEM_%' OR current_modem_id LIKE 'SIM_%') as sims_with_fake_modems,
    (SELECT COUNT(*) FROM modems WHERE manufacturer IS NULL AND model IS NULL) as modems_no_hardware,
    (SELECT COUNT(*) FROM sims WHERE current_modem_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM modems WHERE equipment_id = sims.current_modem_id
    )) as orphaned_sims,
    CASE
        WHEN (SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%') > 0 THEN 'FAIL'
        WHEN (SELECT COUNT(*) FROM sims WHERE current_modem_id LIKE 'MODEM_%') > 0 THEN 'FAIL'
        ELSE 'PASS'
    END as status;
```

### Setup Alerts (Optional)

```bash
# Add to crontab on monitoring server:
# 0 * * * * /path/to/check-data-quality.sh

# check-data-quality.sh:
#!/bin/bash
RESULT=$(npx wrangler d1 execute sms-dashboard --remote --file=sql/monitor-data-quality.sql)

if echo "$RESULT" | grep -q "FAIL"; then
    # Send alert (email, Slack, etc.)
    echo "DATA QUALITY ALERT: Fake modem entries detected!" | mail -s "SMS Dashboard Alert" admin@example.com
fi
```

---

## Success Criteria

### Immediate (After Code Fix)
- [ ] No new MODEM_* entries created in database
- [ ] Daemon logs show "temporarily unavailable" for modems without IMEI
- [ ] No errors in daemon operation

### Short-term (After Cleanup)
- [ ] Zero fake modem entries in database
- [ ] All SIMs either mapped to real modems or set to NULL
- [ ] Archive tables contain complete audit trail

### Long-term (Ongoing)
- [ ] Monitor query returns PASS status for 1 week
- [ ] No fake entries detected in production
- [ ] SIM swaps handled gracefully without corruption

---

## Rollback Plan

If issues occur after code fix:

```bash
# 1. Revert to previous daemon version
ssh root@203.116.95.146 'systemctl stop sms-daemon'
# Deploy previous working version
nixos-rebuild switch --flake .#orange-pi --rollback

# 2. Restore database from backup (if cleanup caused issues)
npx wrangler d1 restore sms-dashboard --backup-id=<backup-id>

# 3. Investigate what went wrong
# Check daemon logs, database state, error patterns
```

---

## Timeline

### Day 1 (Today)
- 09:00-11:00: Implement code fixes
- 11:00-12:00: Test locally and write unit tests
- 12:00-12:30: Deploy to production
- 12:30-13:30: Monitor daemon for issues
- 13:30-14:00: Run analysis script
- 14:00-15:00: Review analysis and plan cleanup strategy

### Day 2 (Tomorrow)
- 09:00-09:30: Create database backup
- 09:30-10:30: Run cleanup script and verify
- 10:30-11:00: Deploy server-side validation
- 11:00-12:00: Add monitoring and constraints
- 12:00-EOD: Monitor for regressions

### Week 1 (Ongoing)
- Daily checks of monitor query
- Review daemon logs for patterns
- Verify no new fake entries

---

## Contact & Support

**Questions about this fix:**
- Review: `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/orange-pi-daemon/FAKE_MODEM_ANALYSIS.md`
- Code: Check files mentioned in Phase 1
- SQL: Review `sql/analyze-fake-modems.sql` and `sql/cleanup-fake-modems.sql`

**If issues occur:**
1. Check daemon logs: `ssh root@203.116.95.146 'journalctl -u sms-daemon -f'`
2. Check API logs: `npx wrangler tail sms-dashboard --format pretty`
3. Run analysis again: `npx wrangler d1 execute sms-dashboard --remote --file=sql/analyze-fake-modems.sql`
4. Rollback if needed (see Rollback Plan above)
