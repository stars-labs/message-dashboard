# Modem Health Indicators Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose per-modem diagnostic indicators (Modem alive, SIM read status, Signal) on the ICCID Mapping page, using IMEI as fallback link when ICCID detection fails.

**Architecture:** The daemon switches from ICCID-gated to IMEI-gated reporting, adding `sim_read_status` to the sync payload. The server stores this in a new `modems.sim_read_status` column. The `device_view` gains a dual-join (ICCID primary, `sims.imei` fallback). The ICCID Mapping page shows multi-indicator columns.

**Tech Stack:** Rust (daemon), Cloudflare Workers/D1 (server), Svelte 5 + TailwindCSS (frontend)

**Spec:** `docs/superpowers/specs/2026-03-16-modem-health-indicators-design.md`

---

## Chunk 1: Daemon Changes (Rust)

### Task 1: Add `sim_read_status` to Rust types

**Files:**
- Modify: `orange-pi-daemon/src/types.rs:28-58` (Modem struct)
- Modify: `orange-pi-daemon/src/types.rs:78-104` (Phone struct)

- [ ] **Step 1: Add `sim_read_status` field to `Phone` struct**

In `orange-pi-daemon/src/types.rs`, add after `usb_port` field (line 103):

```rust
    pub usb_port: Option<String>,
    pub sim_read_status: Option<String>,  // "ok" or "failed"
}
```

- [ ] **Step 2: Add `sim_read_status` field to `Modem` struct**

In `orange-pi-daemon/src/types.rs`, add after `access_tech` field (line 57):

```rust
    pub access_tech: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sim_read_status: Option<String>,  // "ok" or "failed"
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd orange-pi-daemon && cargo check 2>&1 | head -30`

This will fail with errors about missing `sim_read_status` in struct initializations — that's expected at this stage. We'll fix them in the following tasks.

- [ ] **Step 4: Fix all Modem struct initializations**

In `orange-pi-daemon/src/main.rs`, find the Phone-to-Modem conversion (lines 454-475). Add `sim_read_status`:

```rust
                    let modems: Vec<Modem> = all_phones
                        .iter()
                        .map(|p| Modem {
                            equipment_id: p.imei.clone().unwrap_or_else(|| "unknown".to_string()),
                            manufacturer: p.manufacturer.clone(),
                            model: p.model.clone(),
                            firmware_revision: p.firmware_revision.clone(),
                            hardware_revision: p.hardware_revision.clone(),
                            status: p.status.clone(),
                            signal: p.signal,
                            rssi: p.rssi,
                            rsrq: p.rsrq,
                            rsrp: p.rsrp,
                            snr: p.snr,
                            modem_index: p.modem_index,
                            usb_port: p.usb_port.as_ref().and_then(|s| s.parse::<i32>().ok()),
                            connection_status: Some(p.status.clone()),
                            network_type: None,
                            access_tech: p.access_tech.clone(),
                            sim_read_status: p.sim_read_status.clone(),
                        })
                        .collect();
```

- [ ] **Step 5: Verify compilation passes**

Run: `cd orange-pi-daemon && cargo check`
Expected: Still may fail due to Phone struct init in worker_pool.rs — that's Task 2.

---

### Task 2: Remove ICCID gate in `worker_pool.rs`

**Files:**
- Modify: `orange-pi-daemon/src/worker_pool.rs:248-373` (process_single_modem)

- [ ] **Step 1: Rewrite `process_single_modem` to use IMEI as gate**

Replace the function body at `orange-pi-daemon/src/worker_pool.rs:248-373` with:

```rust
    async fn process_single_modem(
        modem_id: String,
        modem_manager: Arc<ModemManager>,
        message_store: Arc<crate::message_store::MessageStore>,
    ) -> Result<ModemResult> {
        debug!("Processing modem {}", modem_id);

        // Get ICCID (may fail — that's ok, IMEI is the gate now)
        let iccid = modem_manager
            .get_iccid(&modem_id)
            .await
            .unwrap_or(None);

        // Get device details — IMEI is the gate
        let device_details = modem_manager
            .get_device_details(&modem_id)
            .await
            .context("Failed to get device details")?;

        let (equipment_id, manufacturer, model, firmware, hardware) = match device_details {
            Some(details) => details,
            None => {
                debug!("Modem {} has no valid IMEI, skipping", modem_id);
                return Ok(ModemResult {
                    modem_id,
                    iccid: None,
                    phone: None,
                    sim: None,
                    messages: vec![],
                    messages_with_paths: vec![],
                    error: Some("No valid IMEI".to_string()),
                });
            }
        };

        // Get signal quality (cached) — always, even without ICCID
        let signal_data = modem_manager
            .get_signal_quality(&modem_id)
            .await
            .unwrap_or_default();

        // Get operator — always
        let operator = modem_manager.get_operator(&modem_id).await.unwrap_or(None);

        let sim_read_status = if iccid.is_some() { "ok" } else { "failed" };

        // Only get phone number and messages if ICCID is available
        let (phone_number, messages, messages_with_paths) = if let Some(ref iccid_val) = iccid {
            let phone_number = modem_manager
                .get_phone_number(&modem_id)
                .await
                .unwrap_or(None);

            let msgs_with_paths = modem_manager
                .get_new_messages_with_paths(&modem_id, iccid_val, &message_store)
                .await
                .unwrap_or_default();

            let msgs: Vec<Message> = msgs_with_paths
                .iter()
                .map(|m| m.message.clone())
                .collect();

            (phone_number, msgs, msgs_with_paths)
        } else {
            (None, vec![], vec![])
        };

        // Build Phone struct — always built when IMEI succeeds
        let phone = Phone {
            iccid: iccid.clone().unwrap_or_default(),
            number: phone_number.clone(),
            signal: Some(signal_data.percent),
            operator_name: operator.clone(),
            status: "active".to_string(),
            manufacturer: manufacturer.clone(),
            model: model.clone(),
            firmware_revision: firmware.clone(),
            hardware_revision: hardware.clone(),
            imei: Some(equipment_id.clone()),
            country: None,
            flag: None,
            carrier: operator.clone(),
            rssi: Some(signal_data.rssi),
            rsrq: None,
            rsrp: None,
            snr: None,
            operator_id: None,
            access_tech: None,
            modem_index: modem_id.parse::<i32>().ok(),
            sim_index: None,
            device_path: None,
            usb_port: None,
            sim_read_status: Some(sim_read_status.to_string()),
        };

        // Build Sim struct — only when ICCID is available
        let sim = iccid.as_ref().map(|iccid_val| Sim {
            iccid: iccid_val.clone(),
            phone_number: phone_number.clone(),
            current_modem_id: Some(equipment_id),
            operator_name: operator,
            operator_id: None,
            status: "active".to_string(),
            sim_index: None,
        });

        Ok(ModemResult {
            modem_id,
            iccid,
            phone: Some(phone),
            sim,
            messages,
            messages_with_paths,
            error: None,
        })
    }
```

- [ ] **Step 2: Verify compilation**

Run: `cd orange-pi-daemon && cargo check`
Expected: PASS (all struct fields now populated)

- [ ] **Step 3: Run existing tests**

Run: `cd orange-pi-daemon && cargo test 2>&1 | tail -20`
Expected: All 61 existing tests pass

- [ ] **Step 4: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add orange-pi-daemon/src/types.rs orange-pi-daemon/src/worker_pool.rs orange-pi-daemon/src/main.rs
git commit -m "feat(daemon): switch from ICCID gate to IMEI gate with sim_read_status

IMEI is now the gate for modem reporting. When ICCID read fails but
IMEI succeeds, the modem is still reported with sim_read_status: failed.
Phone struct is always built when IMEI succeeds. Sim struct is only
built when ICCID also succeeds."
```

---

### Task 3: Update startup cache to accept IMEI-only modems

**Files:**
- Modify: `orange-pi-daemon/src/main.rs:158-235` (startup cache build)
- Modify: `orange-pi-daemon/src/main.rs:592-595` (SMS sender reverse cache)

- [ ] **Step 1: Change `valid_modems` type from `HashMap<String, String>` to `HashMap<String, Option<String>>`**

In `orange-pi-daemon/src/main.rs`, change line 160:

```rust
    let mut valid_modems: HashMap<String, Option<String>> = HashMap::new();
```

- [ ] **Step 2: Restructure the modem cache build loop**

Replace lines 167-223 with IMEI-first logic:

```rust
            for modem_id in modems {
                // Try IMEI first — this is the gate
                let imei = match modem_manager.get_device_details(&modem_id).await {
                    Ok(Some((imei, ..))) => Some(imei),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("⚠️  Failed to get IMEI for modem {}: {}", modem_id, e);
                        None
                    }
                };

                if imei.is_none() {
                    warn!("⚠️  Modem {} has no valid IMEI, skipping", modem_id);
                    continue;
                }

                // Try ICCID — optional, modem is still valid without it
                let iccid = match modem_manager.get_iccid(&modem_id).await {
                    Ok(Some(iccid)) => Some(iccid),
                    Ok(None) => None,
                    Err(e) => {
                        warn!("⚠️  Failed to get ICCID for modem {}: {}", modem_id, e);
                        None
                    }
                };

                valid_modems.insert(modem_id.clone(), iccid.clone());

                match (&imei, &iccid) {
                    (Some(imei), Some(iccid)) => {
                        info!(
                            "✅ Cached modem {} with ICCID {} (IMEI {})",
                            modem_id, iccid, imei
                        );
                    }
                    (Some(imei), None) => {
                        warn!(
                            "⚠️  Cached modem {} without ICCID (IMEI {}) — SIM read failed",
                            modem_id, imei
                        );
                    }
                    _ => unreachable!(), // We already checked imei.is_none()
                }
            }
```

- [ ] **Step 3: Update early-exit check message**

In `orange-pi-daemon/src/main.rs`, find the early-exit check (lines 231-234) and update the error message:

```rust
    if valid_modems.is_empty() {
        error!("❌ No modems with valid IMEI found!");
        error!("💡 Check: mmcli -L");
        return Ok(());
```

- [ ] **Step 4: Update SMS sender reverse cache to filter out None values**

In `orange-pi-daemon/src/main.rs`, replace lines 592-595:

```rust
    let sender_modem_cache: HashMap<String, String> = valid_modems
        .iter()
        .filter_map(|(modem_id, iccid)| {
            iccid.as_ref().map(|i| (i.clone(), modem_id.clone()))
        })
        .collect();
```

- [ ] **Step 5: Verify compilation and tests**

Run: `cd orange-pi-daemon && cargo check && cargo test 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add orange-pi-daemon/src/main.rs
git commit -m "feat(daemon): startup cache accepts IMEI-only modems

valid_modems is now HashMap<String, Option<String>> to include modems
where ICCID read failed but IMEI succeeded. SMS sender reverse cache
filters out None ICCID values."
```

---

## Chunk 2: Database Migration + Server Changes

### Task 4: Create migration `032_add_modem_health_indicators.sql`

**Files:**
- Create: `sms-dashboard/migrations/032_add_modem_health_indicators.sql`

- [ ] **Step 1: Write the migration file**

Create `sms-dashboard/migrations/032_add_modem_health_indicators.sql`:

```sql
-- Migration 032: Add modem health indicators
-- Adds sim_read_status column and dual-join device_view for IMEI fallback

-- 1. Add sim_read_status to modems table
ALTER TABLE modems ADD COLUMN sim_read_status TEXT DEFAULT NULL;
-- Values: 'ok' (ICCID read succeeded), 'failed' (modem alive, ICCID read failed), NULL (legacy)

-- 2. Enforce unique IMEI in sims table to prevent ambiguous fallback join
-- First clear duplicates (keep the one with lowest sim_index)
UPDATE sims SET imei = NULL
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM sims WHERE imei IS NOT NULL GROUP BY imei
) AND imei IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;
DROP INDEX IF EXISTS idx_sims_imei;

-- 3. Recreate device_view with dual join (ICCID primary, sims.imei fallback)
DROP VIEW IF EXISTS device_view;
CREATE VIEW device_view AS
SELECT
  s.iccid as id,
  COALESCE(m_iccid.equipment_id, m_imei.equipment_id) as equipment_id,
  COALESCE(m_iccid.manufacturer, m_imei.manufacturer) as manufacturer,
  COALESCE(m_iccid.model, m_imei.model) as model,
  COALESCE(m_iccid.usb_port, m_imei.usb_port) as primary_port,
  COALESCE(m_iccid.status, m_imei.status) as modem_status,
  s.iccid,
  s.phone_number as number,
  s.carrier,
  s.country_code as country,
  s.sim_index,
  s.notes,
  COALESCE(m_iccid.operator, m_imei.operator) as operator,
  CASE
    WHEN m_iccid.current_iccid IS NOT NULL THEN 'active'
    WHEN m_imei.equipment_id IS NOT NULL THEN 'modem_only'
    ELSE 'inactive'
  END as sim_status,
  COALESCE(m_iccid.sim_read_status, m_imei.sim_read_status) as sim_read_status,
  COALESCE(ms_iccid.signal_percent, ms_imei.signal_percent) as signal_quality,
  COALESCE(ms_iccid.connection_status, ms_imei.connection_status) as connection_status,
  COALESCE(ms_iccid.network_type, ms_imei.network_type) as network_type,
  COALESCE(m_iccid.created_at, m_imei.created_at) as created_at,
  s.updated_at
FROM sims s
LEFT JOIN modems m_iccid ON s.iccid = m_iccid.current_iccid
LEFT JOIN modems m_imei ON s.imei = m_imei.equipment_id
  AND m_iccid.equipment_id IS NULL
LEFT JOIN modem_state ms_iccid ON ms_iccid.modem_id = m_iccid.equipment_id
LEFT JOIN modem_state ms_imei ON ms_imei.modem_id = m_imei.equipment_id
  AND m_iccid.equipment_id IS NULL
ORDER BY s.sim_index ASC;
```

- [ ] **Step 2: Test migration locally**

Run: `cd sms-dashboard && bunx wrangler d1 execute sms-dashboard --local --file=migrations/032_add_modem_health_indicators.sql`
Expected: Success, no errors

- [ ] **Step 3: Verify device_view works**

Run: `cd sms-dashboard && bunx wrangler d1 execute sms-dashboard --local --command="SELECT id, sim_status, sim_read_status FROM device_view LIMIT 5"`
Expected: Rows with sim_status values ('active', 'inactive', or 'modem_only') and sim_read_status (NULL for existing rows)

- [ ] **Step 4: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add sms-dashboard/migrations/032_add_modem_health_indicators.sql
git commit -m "feat(db): add modem health indicators migration 032

Adds sim_read_status column to modems, UNIQUE index on sims.imei,
and dual-join device_view (ICCID primary, sims.imei fallback) with
three-state sim_status: active/modem_only/inactive."
```

---

### Task 5: Update `control.js` to store `sim_read_status`

**Files:**
- Modify: `sms-dashboard/server/handlers/control.js:77-99` (modem upsert)
- Modify: `sms-dashboard/server/handlers/control.js:234-252` (full-sync reconciliation)

- [ ] **Step 1: Add `sim_read_status` to the modem INSERT/ON CONFLICT**

In `sms-dashboard/server/handlers/control.js`, replace the modem upsert (lines 77-99):

```javascript
        batch.push(env.DB.prepare(`
          INSERT INTO modems (
            equipment_id, manufacturer, model, firmware_revision,
            hardware_revision, status, sim_read_status,
            verification_status, last_verified_session,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(equipment_id) DO UPDATE SET
            manufacturer = excluded.manufacturer,
            model = excluded.model,
            firmware_revision = excluded.firmware_revision,
            hardware_revision = excluded.hardware_revision,
            status = excluded.status,
            sim_read_status = excluded.sim_read_status,
            verification_status = COALESCE(excluded.verification_status, modems.verification_status),
            last_verified_session = COALESCE(excluded.last_verified_session, modems.last_verified_session),
            updated_at = CURRENT_TIMESTAMP
        `).bind(
          modem.equipment_id,
          modem.manufacturer || null,
          modem.model || null,
          modem.firmware_revision || null,
          modem.hardware_revision || null,
          modem.status || 'unknown',
          modem.sim_read_status || null,
          verificationStatus,
          lastVerifiedSession
        ));
```

- [ ] **Step 2: Add stale ICCID clearing for failed SIM reads**

After the modem upsert loop (after line 136 `}` closing `for (const modem of modems)`), add:

```javascript
      // Clear stale current_iccid for modems with failed SIM reads
      for (const modem of modems) {
        if (modem.sim_read_status === 'failed' && modem.equipment_id) {
          batch.push(env.DB.prepare(`
            UPDATE modems SET current_iccid = NULL, detected_phone_number = NULL
            WHERE equipment_id = ? AND sim_read_status = 'failed'
          `).bind(modem.equipment_id));
        }
      }
```

- [ ] **Step 3: Update full-sync reconciliation to clear `sim_read_status`**

In the reconciliation section (lines 244-250), update the clear SIM associations query:

```javascript
        const clearSimsResult = await env.DB.prepare(`
          UPDATE modems
          SET current_iccid = NULL,
              detected_phone_number = NULL,
              operator = NULL,
              sim_read_status = NULL
          WHERE verification_status = 'absent'
        `).run();
```

- [ ] **Step 4: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add sms-dashboard/server/handlers/control.js
git commit -m "feat(server): store sim_read_status and clear stale ICCID on failed reads

Modem upsert now includes sim_read_status column. Modems with
sim_read_status='failed' get current_iccid cleared. Full-sync
reconciliation also clears sim_read_status for absent modems."
```

---

### Task 6: Update `iccid-mappings.js` to use `device_view`

**Files:**
- Modify: `sms-dashboard/server/handlers/iccid-mappings.js:14-35` (list query)
- Modify: `sms-dashboard/server/handlers/iccid-mappings.js:95-115` (get by id query)
- Modify: `sms-dashboard/server/handlers/iccid-mappings.js:151-171` (getByIccid query)

- [ ] **Step 1: Replace the list query to use `device_view` directly**

In `sms-dashboard/server/handlers/iccid-mappings.js`, replace the query at lines 14-35:

```javascript
    let query = `
      SELECT
        iccid as id,
        iccid,
        sim_index,
        number as phone_number,
        country,
        carrier,
        equipment_id,
        notes,
        sim_status as is_active,
        sim_read_status,
        signal_quality,
        modem_status,
        created_at,
        updated_at
      FROM device_view
      WHERE 1=1
    `;
```

Note: The `is_active` field now returns `'active'`, `'modem_only'`, or `'inactive'`.

- [ ] **Step 2: Update `get` method to use `device_view`**

Replace the query at lines 95-115 in the `get` method:

```javascript
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id, iccid, sim_index, number as phone_number,
          country, carrier, equipment_id, notes,
          sim_status as is_active, sim_read_status, signal_quality, modem_status,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(id).first();
```

- [ ] **Step 3: Update `getByIccid` method to use `device_view`**

Replace the query at lines 151-171 in the `getByIccid` method:

```javascript
      const mapping = await env.DB.prepare(`
        SELECT
          iccid as id, iccid, sim_index, number as phone_number,
          country, carrier, equipment_id, notes,
          sim_status as is_active, sim_read_status, signal_quality, modem_status,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(iccid).first();
```

- [ ] **Step 4: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add sms-dashboard/server/handlers/iccid-mappings.js
git commit -m "feat(server): all iccid-mappings queries use device_view with health indicators

list, get, and getByIccid all use device_view now, returning consistent
three-state sim_status plus sim_read_status, signal_quality, modem_status."
```

---

### Task 7: Update `device-count.js` with `modem_only` count

**Files:**
- Modify: `sms-dashboard/server/utils/device-count.js:8-19` (stats query)
- Modify: `sms-dashboard/server/utils/device-count.js:43-67` (return object)

- [ ] **Step 1: Add `modem_only_sims` to the stats query and fix inactive count**

In `sms-dashboard/server/utils/device-count.js`, replace the stats query (lines 8-19):

```javascript
  const stats = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM modems WHERE status IN ('connected', 'registered', 'active')) as connected_modems,
      (SELECT COUNT(*) FROM modems WHERE status = 'disconnected') as disconnected_modems,
      (SELECT COUNT(*) FROM modems) as total_modems,
      (SELECT COUNT(*) FROM device_view WHERE sim_status = 'active') as active_sims,
      (SELECT COUNT(*) FROM device_view WHERE sim_status = 'inactive') as inactive_sims,
      (SELECT COUNT(*) FROM device_view WHERE sim_status = 'modem_only') as modem_only_sims,
      (SELECT COUNT(DISTINCT equipment_id) FROM modems WHERE current_iccid IS NOT NULL) as modems_with_sims
  `).first();
```

Note: `active_sims` and `inactive_sims` now use `device_view` with the three-state `sim_status`, preventing double-counting of `modem_only` SIMs.

- [ ] **Step 2: Update totalSims calculation and return object**

Replace the totalSims calculation (line 23) and sims section of the return object (lines 51-54):

```javascript
  const totalSims = (stats.active_sims || 0) + (stats.inactive_sims || 0) + (stats.modem_only_sims || 0);
```

And in the return object:

```javascript
    sims: {
      total: totalSims,
      active: stats.active_sims || 0,
      inactive: stats.inactive_sims || 0,
      modem_only: stats.modem_only_sims || 0
    },
```

- [ ] **Step 3: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add sms-dashboard/server/utils/device-count.js
git commit -m "feat(server): add modem_only count to device stats

Stats API now returns sims.modem_only count for SIMs where
modem is alive but ICCID read failed."
```

---

## Chunk 3: Frontend Changes (Svelte)

### Task 8: Update ICCID Mappings table with multi-indicator columns

**Files:**
- Modify: `sms-dashboard/client/lib/IccidMappings.svelte`

- [ ] **Step 1: Update computed stats to include error count**

In `sms-dashboard/client/lib/IccidMappings.svelte`, replace lines 14-20:

```javascript
  let statusFilter = "all"; // "all", "active", "error", "inactive"
  let successMessage = null;

  // Computed stats
  $: activeCount = allMappingsCache.filter(m => m.is_active === 'active').length;
  $: errorCount = allMappingsCache.filter(m => m.is_active === 'modem_only').length;
  $: inactiveCount = allMappingsCache.filter(m => m.is_active === 'inactive' || !m.is_active).length;
  $: totalCount = allMappingsCache.length;
```

- [ ] **Step 2: Update filter function to handle 'error' status**

Replace lines 60-68 (the `filterMappings` status filter section):

```javascript
  function filterMappings() {
    let filtered = allMappingsCache;

    // Filter by status
    if (statusFilter === "active") {
      filtered = filtered.filter(m => m.is_active === 'active');
    } else if (statusFilter === "error") {
      filtered = filtered.filter(m => m.is_active === 'modem_only');
    } else if (statusFilter === "inactive") {
      filtered = filtered.filter(m => m.is_active === 'inactive' || !m.is_active);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((m) =>
        (m.iccid || "").toLowerCase().includes(q) ||
        (m.phone_number || "").toLowerCase().includes(q) ||
        (m.carrier || "").toLowerCase().includes(q) ||
        (m.equipment_id || "").toLowerCase().includes(q) ||
        (m.notes || m.description || "").toLowerCase().includes(q)
      );
    }

    mappings = filtered;
  }
```

- [ ] **Step 3: Add Error filter tab button**

In the filter bar (lines 190-215), add an Error button between Active and Inactive:

Replace lines 196-208 with:

```svelte
    <button
      on:click={() => statusFilter = "active"}
      class="px-4 py-2 rounded-lg transition-colors whitespace-nowrap {statusFilter === 'active' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-600 hover:bg-green-100'}"
    >
      活动 ({activeCount})
    </button>
    <button
      on:click={() => statusFilter = "error"}
      class="px-4 py-2 rounded-lg transition-colors whitespace-nowrap {statusFilter === 'error' ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-600 hover:bg-amber-100'}"
    >
      异常 ({errorCount})
    </button>
    <button
      on:click={() => statusFilter = "inactive"}
      class="px-4 py-2 rounded-lg transition-colors whitespace-nowrap {statusFilter === 'inactive' ? 'bg-stone-500 text-white' : 'bg-stone-50 text-stone-500 hover:bg-stone-100'}"
    >
      未激活 ({inactiveCount})
    </button>
```

- [ ] **Step 4: Replace the single Status column header with multi-indicator columns**

Replace the table header section (lines 258-301). Replace the single `状态` th with three new columns. The full thead becomes:

```svelte
          <thead>
            <tr class="border-b border-stone-200">
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">SIM#</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">ICCID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">手机号</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">国家</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">运营商</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">设备ID</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">备注</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">Modem</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">SIM读取</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">信号</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">状态</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-stone-500 uppercase tracking-wider">操作</th>
            </tr>
          </thead>
```

Note: Removed "创建时间" (created_at) column to make room — it's rarely useful in the inventory view.

- [ ] **Step 5: Replace the status badge cell with multi-indicator cells**

Replace the status and created_at cells (lines 346-357) with:

```svelte
              <!-- Modem indicator -->
              <td class="px-4 py-3">
                {#if mapping.equipment_id && mapping.modem_status && mapping.modem_status !== 'disconnected'}
                  <span class="inline-flex items-center gap-1 text-xs">
                    <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span class="text-emerald-700">UP</span>
                  </span>
                {:else if mapping.equipment_id}
                  <span class="inline-flex items-center gap-1 text-xs">
                    <span class="w-2 h-2 rounded-full bg-red-500"></span>
                    <span class="text-red-600">DOWN</span>
                  </span>
                {:else}
                  <span class="text-stone-300 text-xs">—</span>
                {/if}
              </td>
              <!-- SIM Read indicator -->
              <td class="px-4 py-3">
                {#if mapping.sim_read_status === 'ok'}
                  <span class="inline-flex px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">OK</span>
                {:else if mapping.sim_read_status === 'failed'}
                  <span class="inline-flex px-2 py-0.5 text-xs rounded-full bg-red-50 text-red-600 border border-red-200">FAIL</span>
                {:else}
                  <span class="text-stone-300 text-xs">—</span>
                {/if}
              </td>
              <!-- Signal -->
              <td class="px-4 py-3">
                {#if mapping.signal_quality != null}
                  <span class="text-xs font-mono {mapping.signal_quality >= 60 ? 'text-emerald-600' : mapping.signal_quality >= 30 ? 'text-amber-600' : 'text-red-600'}">
                    {mapping.signal_quality}%
                  </span>
                {:else}
                  <span class="text-stone-300 text-xs">—</span>
                {/if}
              </td>
              <!-- Summary status badge -->
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-1 text-xs rounded-full {
                    mapping.is_active === 'active'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : mapping.is_active === 'modem_only'
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-stone-100 text-stone-500 border border-stone-200'
                  }"
                >
                  {mapping.is_active === 'active' ? '活动' : mapping.is_active === 'modem_only' ? '异常' : '未激活'}
                </span>
              </td>
```

- [ ] **Step 6: Verify frontend builds**

Run: `cd sms-dashboard && bun run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
cd /home/loki/code/stars-labs/message-dashboard
git add sms-dashboard/client/lib/IccidMappings.svelte
git commit -m "feat(frontend): add modem health indicator columns to ICCID Mappings

Replaces single Active/Inactive badge with Modem (UP/DOWN), SIM Read
(OK/FAIL), Signal (%), and summary Status (Active/Error/Inactive).
Adds Error filter tab for modem_only status."
```

---

## Chunk 4: Verification

### Task 9: End-to-end verification

- [ ] **Step 1: Run Rust daemon tests**

Run: `cd orange-pi-daemon && cargo test 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 2: Run frontend build**

Run: `cd sms-dashboard && bun run build`
Expected: Build succeeds with no errors

- [ ] **Step 3: Test migration on local D1**

Run: `cd sms-dashboard && bunx wrangler d1 execute sms-dashboard --local --file=migrations/032_add_modem_health_indicators.sql`
Expected: Success

- [ ] **Step 4: Verify device_view returns correct columns**

Run: `cd sms-dashboard && bunx wrangler d1 execute sms-dashboard --local --command="SELECT id, sim_status, sim_read_status, signal_quality, modem_status FROM device_view LIMIT 10"`
Expected: Rows with all new columns present

- [ ] **Step 5: Final commit (if any fixups needed)**

Only if previous steps required fixes.
