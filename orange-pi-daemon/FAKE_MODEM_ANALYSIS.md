# Root Cause Analysis: Fake MODEM_ Entries

## Problem Statement

When SIM cards are changed, the daemon creates fake modem entries like "MODEM_35", "MODEM_17", "MODEM_71" with:
- Null manufacturer, model, and other hardware fields
- These corrupt the database and break SIM-to-modem tracking

## Root Cause Identification

### 1. Primary Issue: Fallback Logic in `modem_manager.rs` (Lines 88-98)

```rust
pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
    let details = self.dbus_client.get_device_details(modem_id).await?;

    let imei = if details.imei.is_empty() {
        format!("MODEM_{}", modem_id)  // ❌ BUG: Creates fake equipment_id
    } else {
        details.imei
    };

    Ok((imei, details.manufacturer, details.model, details.firmware_version, details.hardware_revision))
}
```

**When this triggers:**
- D-Bus fails to retrieve IMEI from ModemManager
- Modem is in transitional state during SIM swap
- ModemManager hasn't fully initialized the modem yet

### 2. Secondary Issue: Worker Pool Continues with Fake Data (Lines 238-247)

```rust
// Get device details
let (equipment_id, manufacturer, model, firmware, hardware) = modem_manager
    .get_device_details(&modem_id)
    .await
    .unwrap_or_else(|_| (
        format!("MODEM_{}", modem_id),  // ❌ BUG: Error handler creates fake ID
        None,
        None,
        None,
        None,
    ));
```

**Impact:**
- Even when D-Bus completely fails, worker pool creates a modem with fake ID
- All hardware fields are NULL
- This gets sent to API and stored in database

### 3. Tertiary Issue: Main Loop Converts to Modem (Lines 244-263)

```rust
let modems: Vec<Modem> = all_phones.iter().map(|phone| {
    Modem {
        equipment_id: phone.imei.clone().unwrap_or_else(|| format!("MODEM_{}", phone.iccid)),  // ❌ BUG: Another fallback
        manufacturer: phone.manufacturer.clone(),
        model: phone.model.clone(),
        // ... all fields become None when phone.imei is fake
    }
}).collect();
```

### 4. Server-Side Accepts Invalid Data (control.js Lines 59-94)

```javascript
for (const modem of modems) {
    if (!modem.equipment_id) {
        console.warn('[control.js] Skipping modem without equipment_id');
        continue;
    }

    // ❌ BUG: Accepts "MODEM_35" as valid equipment_id
    batch.push(env.DB.prepare(`
        INSERT INTO modems (
            equipment_id, manufacturer, model, firmware_revision,
            hardware_revision, status,
            // ...
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
```

**Server validation only checks:**
- `equipment_id` is not empty
- Does NOT validate format or presence of hardware info

## Data Flow Timeline During SIM Swap

```
Time  Event
----  -----
T0    User removes SIM card from Modem A (IMEI: 865827078383361)
T0+1s ModemManager detects SIM removal, ICCID becomes NULL
T0+2s Daemon sync: Modem A has no SIM, doesn't appear in valid_modems cache
T0+5s User inserts same SIM into Modem B (IMEI: 865827078383362)
T0+6s ModemManager initializing Modem B, D-Bus calls may fail/timeout
T0+7s Worker pool processes modem_id "35" (Modem B):
      - get_iccid() succeeds → returns ICCID
      - get_device_details() fails → creates "MODEM_35"
      - get_signal_quality() succeeds
T0+8s Daemon uploads:
      {
        equipment_id: "MODEM_35",
        manufacturer: null,
        model: null,
        firmware_revision: null,
        hardware_revision: null,
        status: "connected"
      }
T0+9s Database now has corrupted entry for "MODEM_35"
T0+30s Next full sync, ModemManager stable:
      - get_device_details() succeeds → returns real IMEI
      - But "MODEM_35" already exists in database
      - Creates NEW entry for real IMEI "865827078383362"
Result: Database has BOTH fake "MODEM_35" and real "865827078383362"
```

## Examples of Corruption

### Database State After SIM Swaps

```sql
SELECT equipment_id, manufacturer, model, status, updated_at FROM modems WHERE equipment_id LIKE 'MODEM_%';

equipment_id  | manufacturer | model | status     | updated_at
-------------|--------------|-------|------------|-------------------
MODEM_17     | NULL         | NULL  | connected  | 2025-01-20 10:15:23
MODEM_35     | NULL         | NULL  | connected  | 2025-01-20 10:22:41
MODEM_71     | NULL         | NULL  | connected  | 2025-01-20 10:35:17
```

### SIM Tracking Broken

```sql
SELECT s.iccid, s.current_modem_id, m.manufacturer, m.model
FROM sims s
LEFT JOIN modems m ON s.current_modem_id = m.equipment_id
WHERE s.current_modem_id LIKE 'MODEM_%';

iccid               | current_modem_id | manufacturer | model
--------------------|------------------|--------------|------
89860478123456789   | MODEM_35        | NULL         | NULL
89860478234567890   | MODEM_17        | NULL         | NULL
89860478345678901   | MODEM_71        | NULL         | NULL
```

## Impact Assessment

### Critical Issues

1. **Data Integrity**: Fake modem entries pollute the `modems` table
2. **SIM Tracking Lost**: Cannot determine real hardware for SIMs
3. **Duplicate Entries**: Same physical modem has multiple IDs in database
4. **Historical Data Corruption**: `modem_sim_history` contains fake associations
5. **Frontend Confusion**: Device view shows modems with no manufacturer/model

### Performance Impact

- Increased database size from duplicate entries
- Queries slower due to filtering out fake entries
- WebSocket broadcasts send fake data to frontend

### Business Impact

- Cannot track which physical modem has issues
- Hardware warranty claims become impossible
- Operator billing/routing decisions based on corrupted data

## Proposed Solutions

### Solution 1: Skip Modems Without Valid IMEI (Recommended)

**Approach**: Treat missing IMEI as a temporary error, skip the modem entirely

**Changes Required:**

#### A. modem_manager.rs
```rust
pub async fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
    let details = self.dbus_client.get_device_details(modem_id).await?;

    // CHANGE: Fail instead of creating fake IMEI
    if details.imei.is_empty() {
        return Err(anyhow!("Modem {} has no IMEI - likely in transitional state", modem_id));
    }

    Ok((details.imei, details.manufacturer, details.model, details.firmware_version, details.hardware_revision))
}
```

#### B. worker_pool.rs
```rust
// Get device details - FAIL if no valid IMEI
let (equipment_id, manufacturer, model, firmware, hardware) = modem_manager
    .get_device_details(&modem_id)
    .await
    .context("Failed to get device details with valid IMEI")?;  // CHANGE: Don't use unwrap_or_else

// Validate equipment_id format (must be IMEI, not MODEM_*)
if equipment_id.starts_with("MODEM_") || equipment_id.is_empty() {
    return Err(anyhow!("Invalid equipment_id format: {}", equipment_id));
}
```

#### C. main.rs
```rust
match worker_pool.process_modems(modem_ids.clone()).await {
    Ok(results) => {
        for result in results {
            if let Some(error) = &result.error {
                // CHANGE: Log but don't panic on transitional errors
                if error.contains("no IMEI") || error.contains("transitional state") {
                    debug!("⏳ Modem {} temporarily unavailable: {}", result.modem_id, error);
                } else {
                    warn!("⚠️  Modem {} error: {}", result.modem_id, error);
                }
                continue;  // Skip this modem for this cycle
            }
            // ... rest of processing
        }
    }
}
```

**Pros:**
- Simple, minimal code changes
- Prevents fake data from ever being created
- Modem will appear in next sync cycle when stable

**Cons:**
- Brief gaps in data during SIM swaps
- May miss some messages during transition (acceptable)

### Solution 2: Add Retry with Exponential Backoff

**Approach**: Retry get_device_details() with delays before giving up

```rust
pub async fn get_device_details_with_retry(&self, modem_id: &str, max_retries: u32) -> Result<DeviceDetails> {
    let mut retries = 0;
    let mut delay = Duration::from_millis(500);

    loop {
        match self.dbus_client.get_device_details(modem_id).await {
            Ok(details) if !details.imei.is_empty() => {
                return Ok(details);
            }
            Ok(_) | Err(_) if retries < max_retries => {
                retries += 1;
                warn!("⏳ Modem {} not ready (attempt {}/{}), retrying in {:?}",
                      modem_id, retries, max_retries, delay);
                tokio::time::sleep(delay).await;
                delay *= 2;  // Exponential backoff
            }
            _ => {
                return Err(anyhow!("Modem {} failed to provide IMEI after {} retries", modem_id, max_retries));
            }
        }
    }
}
```

**Pros:**
- Higher success rate during SIM swaps
- More resilient to temporary D-Bus glitches

**Cons:**
- Adds latency to sync cycle
- More complex code
- Could delay detection of actual hardware failures

### Solution 3: Server-Side Validation (Defense in Depth)

**Approach**: Add validation in control.js to reject fake equipment_ids

```javascript
for (const modem of modems) {
    // CHANGE: Validate equipment_id format
    if (!modem.equipment_id || modem.equipment_id.startsWith('MODEM_')) {
        console.warn(`[control.js] Rejecting invalid equipment_id: ${modem.equipment_id}`);
        continue;
    }

    // CHANGE: Require minimum hardware info
    if (!modem.manufacturer && !modem.model) {
        console.warn(`[control.js] Rejecting modem ${modem.equipment_id} with no hardware info`);
        continue;
    }

    // ... rest of insertion
}
```

**Pros:**
- Protects database even if daemon has bugs
- Easy to add additional validation rules
- Can be deployed independently

**Cons:**
- Doesn't fix root cause
- Data still transmitted over network

## Recommended Implementation Plan

### Phase 1: Immediate Fix (Prevent New Corruption)

1. **Update modem_manager.rs**: Return error instead of fake IMEI
2. **Update worker_pool.rs**: Remove unwrap_or_else fallback
3. **Update main.rs**: Skip modems with IMEI errors
4. **Deploy to production**: Build and deploy daemon

### Phase 2: Server-Side Hardening (This Week)

1. **Add validation in control.js**: Reject MODEM_* equipment_ids
2. **Add hardware info requirement**: At least manufacturer OR model
3. **Deploy to Cloudflare**: Push updated worker

### Phase 3: Database Cleanup (Next Week)

1. **Identify fake entries**:
```sql
SELECT equipment_id, COUNT(*) as sim_count
FROM sims
WHERE current_modem_id LIKE 'MODEM_%'
GROUP BY equipment_id;
```

2. **Create cleanup script**:
```sql
-- Find real modems for these SIMs (by signal timing correlation)
-- Update sims.current_modem_id to point to real IMEI
-- Delete fake modem entries
-- Archive modem_sim_history with fake IDs
```

3. **Manual verification**: Check critical SIMs are mapped correctly

### Phase 4: Monitoring & Alerts (Ongoing)

1. **Add metric**: Count of MODEM_* entries in database
2. **Alert if > 0**: Email/Slack notification
3. **Dashboard widget**: Show fake entry count prominently

## Testing Plan

### Unit Tests

```rust
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn test_get_device_details_fails_on_empty_imei() {
        // Mock D-Bus to return empty IMEI
        // Verify function returns Err instead of "MODEM_XX"
    }

    #[tokio::test]
    async fn test_worker_pool_skips_modems_without_imei() {
        // Mock modem with no IMEI
        // Verify result has error, no Phone/Sim data
    }
}
```

### Integration Tests

```bash
# Test 1: SIM swap scenario
1. Record initial state (ICCID in Modem A)
2. Trigger SIM swap (move to Modem B)
3. Run daemon sync immediately
4. Verify: No MODEM_* entries created
5. Wait 30s for ModemManager to stabilize
6. Run daemon sync again
7. Verify: SIM correctly mapped to Modem B IMEI

# Test 2: Temporary D-Bus failure
1. Block D-Bus for modem 35 (firewall rule)
2. Run daemon sync
3. Verify: Modem 35 skipped with warning
4. Unblock D-Bus
5. Run daemon sync
6. Verify: Modem 35 appears with valid IMEI
```

### Production Validation

```sql
-- Monitor query (run hourly)
SELECT
    COUNT(*) as fake_modem_count,
    MAX(updated_at) as last_fake_entry
FROM modems
WHERE equipment_id LIKE 'MODEM_%';

-- Should always return: fake_modem_count = 0
```

## Migration Strategy for Existing Data

### Step 1: Analyze Current Corruption

```sql
-- Find all fake modems
CREATE TEMP TABLE fake_modems AS
SELECT equipment_id, updated_at
FROM modems
WHERE equipment_id LIKE 'MODEM_%';

-- Find affected SIMs
SELECT s.iccid, s.current_modem_id, s.phone_number, s.updated_at
FROM sims s
INNER JOIN fake_modems f ON s.current_modem_id = f.equipment_id
ORDER BY s.updated_at DESC;
```

### Step 2: Map Fake IDs to Real Hardware

**Strategy**: Use temporal correlation and signal data

```sql
-- For each fake modem, find the real modem that was active at same time
-- with matching USB port or signal characteristics
SELECT
    s.iccid,
    s.current_modem_id as fake_modem,
    m.equipment_id as real_modem,
    m.manufacturer,
    m.model,
    ms.usb_port,
    ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) as time_diff_seconds
FROM sims s
INNER JOIN fake_modems f ON s.current_modem_id = f.equipment_id
CROSS JOIN modems m
LEFT JOIN modem_state ms ON m.equipment_id = ms.modem_id
WHERE m.equipment_id NOT LIKE 'MODEM_%'
  AND m.status = 'connected'
  -- Within 5 minute window
  AND ABS(strftime('%s', s.updated_at) - strftime('%s', m.updated_at)) < 300
ORDER BY s.iccid, time_diff_seconds ASC;
```

### Step 3: Execute Cleanup

```sql
-- 1. Update SIMs to point to real modems
UPDATE sims
SET current_modem_id = (
    -- Subquery to find real modem by temporal correlation
)
WHERE current_modem_id IN (SELECT equipment_id FROM fake_modems);

-- 2. Archive fake modem data (for audit trail)
CREATE TABLE modems_archive_fake AS
SELECT *, CURRENT_TIMESTAMP as archived_at
FROM modems
WHERE equipment_id LIKE 'MODEM_%';

-- 3. Delete fake modems
DELETE FROM modems WHERE equipment_id LIKE 'MODEM_%';

-- 4. Update modem_sim_history
UPDATE modem_sim_history
SET notes = 'Corrected from fake modem ID'
WHERE modem_id IN (SELECT equipment_id FROM fake_modems);
```

### Step 4: Verify Cleanup

```sql
-- Should return 0
SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%';

-- All SIMs should have real modems or NULL
SELECT COUNT(*) FROM sims WHERE current_modem_id LIKE 'MODEM_%';

-- Check for orphaned SIMs
SELECT COUNT(*) FROM sims
WHERE current_modem_id IS NOT NULL
  AND current_modem_id NOT IN (SELECT equipment_id FROM modems);
```

## Prevention Measures

### Code Review Checklist

- [ ] No fallback to fake IDs (MODEM_*, SIM_*, etc.)
- [ ] All equipment_id must be real IMEI from hardware
- [ ] Error cases should skip/retry, not create synthetic data
- [ ] Server validation rejects invalid equipment_id formats

### CI/CD Checks

```yaml
# .github/workflows/validation.yml
- name: Check for fake ID generation
  run: |
    if grep -r 'format!.*MODEM_' orange-pi-daemon/src/; then
      echo "ERROR: Found MODEM_ fallback pattern"
      exit 1
    fi
```

### Database Constraints

```sql
-- Add check constraint to prevent fake IDs
ALTER TABLE modems ADD CONSTRAINT chk_equipment_id
  CHECK (equipment_id NOT LIKE 'MODEM_%' AND equipment_id NOT LIKE 'SIM_%');
```

## Appendix: Alternative Approaches Considered

### Approach A: Synthetic Stable IDs
- Generate UUID for each modem based on USB port
- REJECTED: Loses ability to track IMEI for warranty/support

### Approach B: Separate Unknown Modems Table
- Create `unknown_modems` table for transitional states
- REJECTED: Adds complexity, still doesn't solve root cause

### Approach C: Always Use modem_id Instead of IMEI
- Make modem_id (0, 1, 2...) the primary identifier
- REJECTED: modem_id changes when USB devices are reordered

## Conclusion

The fake MODEM_ entries are caused by defensive programming that prioritizes "never crash" over "never corrupt data". The fix is straightforward:

1. **Fail fast** when IMEI is unavailable
2. **Skip the modem** for this sync cycle
3. **Retry automatically** on next cycle (30s later)
4. **Validate server-side** as defense in depth

This approach aligns with the "fail fast with descriptive messages" principle from the development guidelines and prevents silent data corruption.
