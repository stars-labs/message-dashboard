# Modem Health Indicators — Design Spec

## Problem

When ICCID read fails on a modem, the daemon silently drops the modem from all reporting. The frontend shows a binary Active/Inactive status with no visibility into *why* a SIM appears inactive. For 100+ modems, this makes troubleshooting blind — operators can't distinguish a dirty SIM contact from a dead USB port.

## Solution

Expose per-modem diagnostic indicators (Modem alive, SIM read status, Signal) on the ICCID Mapping page, using IMEI as a fallback link when ICCID detection fails.

## Key Decisions

- **IMEI becomes the gate** (not ICCID): if the daemon can read IMEI, the modem is reported even without ICCID
- **`sims.imei` provides fallback linking**: the user-maintained IMEI field in the inventory links SIMs to modems when ICCID-based matching fails
- **Extend `modems` table** (not a new table): add `sim_read_status` column
- **ICCID Mapping page** is the target UI: it's the inventory view where users manage fixed SIM+modem assignments
- **`sims.imei` must be UNIQUE**: prevents ambiguous fallback join results

## Architecture

### Data Flow

```
Modem AT probe
  ├─ IMEI ok + ICCID ok → Phone/Sim with sim_read_status: "ok"
  ├─ IMEI ok + ICCID fail → Phone (no Sim) with sim_read_status: "failed"
  └─ IMEI fail → bail (modem truly unresponsive, not reported)

Daemon sync → POST /api/control/devices
  └─ Server upserts modems (including IMEI-only rows with current_iccid = NULL)

device_view (dual join):
  sims
    LEFT JOIN modems m_iccid ON sims.iccid = m_iccid.current_iccid       ← primary
    LEFT JOIN modems m_imei  ON sims.imei  = m_imei.equipment_id          ← fallback (when m_iccid misses)
```

### Status Matrix

| IMEI | ICCID | sim_status   | Modem col | SIM Read col | Meaning                         |
|------|-------|--------------|-----------|--------------|---------------------------------|
| OK   | OK    | `active`     | UP (green)| OK (green)   | Fully working                   |
| OK   | FAIL  | `modem_only` | UP (green)| FAIL (red)   | Modem alive, SIM read issue     |
| —    | —     | `inactive`   | — (gray)  | — (gray)     | SIM not in any modem            |

Previously-seen modems that stop reporting transition to disconnected status via the existing full-sync reconciliation mechanism (which now also clears `sim_read_status`).

---

## Layer 1: Daemon Changes

### 1.1 `worker_pool.rs` — Remove ICCID gate

Current flow:
```
get_iccid() → None? → bail early (phone: None, sim: None)
```

New flow:
```
get_iccid() → iccid: Option<String>
get_device_details() → ALWAYS called
  if IMEI fails → bail (modem truly unresponsive)
  if IMEI ok:
    get_signal_quality() → ALWAYS called
    get_operator() → ALWAYS called
    if iccid is Some:
      get_phone_number() → called
      build Phone with sim_read_status: "ok"
      build Sim struct
    if iccid is None:
      build Phone with sim_read_status: "failed", iccid: None
      skip Sim struct (no ICCID to associate)
```

The `ModemResult` struct: `phone` is now populated whenever IMEI succeeds. `sim` is only populated when ICCID also succeeds.

### 1.2 `main.rs` — Startup cache accepts IMEI-only modems

Current: `valid_modems: HashMap<String, String>` (modem_id → iccid). Only modems with ICCID.

New: `valid_modems: HashMap<String, Option<String>>` (modem_id → optional iccid). Any modem with a valid AT response + IMEI is included.

The `modem_ids` vec used by all 6 background tasks is derived from this map's keys, so IMEI-only modems participate in the 30s sync cycle, message reading (will find no messages without ICCID, which is fine), etc.

**SMS sender reverse cache**: The existing `sender_modem_cache` (line ~592 in `main.rs`) builds a `HashMap<iccid, modem_id>` from `valid_modems`. With `Option<String>` values, this must filter out `None` values:
```rust
let sender_modem_cache: HashMap<String, String> = valid_modems
    .iter()
    .filter_map(|(modem_id, iccid)| {
        iccid.as_ref().map(|i| (i.clone(), modem_id.clone()))
    })
    .collect();
```

### 1.3 `api_client.rs` / `types.rs` — Payload includes `sim_read_status`

Add `sim_read_status: String` to both the `Phone` struct and the `Modem` struct in `types.rs`. The Phone-to-Modem conversion in `main.rs` (Task 3, line ~456) must map the field through.

The sync payload now includes IMEI-only modems:
```json
{
  "modems": [
    {
      "equipment_id": "861234567890123",
      "manufacturer": "Quectel",
      "model": "EC20",
      "sim_read_status": "failed",
      "signal_percent": 65,
      ...
    }
  ],
  "sims": []
}
```

Note: `current_iccid` is not in the `Modem` struct — it is set server-side from the `Sim` struct. For IMEI-only modems with no `Sim`, the server must explicitly clear stale `current_iccid` (see Section 2.2).

### 1.4 Phone/Sim struct changes

`Phone` struct gains:
- `sim_read_status: String` — `"ok"` or `"failed"`

`Modem` struct gains:
- `sim_read_status: String` — `"ok"` or `"failed"`

No changes to `Sim` struct — it's simply not created when ICCID fails.

---

## Layer 2: Database Changes

### 2.1 Migration `032_add_modem_health_indicators.sql`

```sql
-- Add sim_read_status to modems table
ALTER TABLE modems ADD COLUMN sim_read_status TEXT DEFAULT NULL;
-- Values: 'ok' (ICCID read succeeded), 'failed' (modem alive, ICCID read failed), NULL (legacy/unknown)

-- Enforce unique IMEI in sims table to prevent ambiguous fallback join
-- First check for duplicates and clear them (keep the one with lowest sim_index)
UPDATE sims SET imei = NULL
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM sims WHERE imei IS NOT NULL GROUP BY imei
) AND imei IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sims_imei_unique ON sims(imei) WHERE imei IS NOT NULL;
DROP INDEX IF EXISTS idx_sims_imei;

-- Recreate device_view with dual join
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
-- Note: the double LEFT JOIN is fine for ~95 SIM rows. The AND m_iccid.equipment_id IS NULL
-- condition prevents SQLite from using an index on m_imei, but at this scale it's negligible.
```

### 2.2 `control.js` — Store `sim_read_status` and clear stale `current_iccid`

**Modem upsert**: Add `sim_read_status` to the existing INSERT/ON CONFLICT statement in `control.js` (lines ~78-102). Add it as a new column in the INSERT column list and the ON CONFLICT UPDATE SET clause.

**Stale ICCID clearing**: After the modem upsert loop, for each modem in the sync that has `sim_read_status = 'failed'`, explicitly clear `current_iccid`:
```sql
UPDATE modems SET current_iccid = NULL, detected_phone_number = NULL
WHERE equipment_id = ? AND sim_read_status = 'failed'
```
This prevents stale `current_iccid` values from a previous successful read from persisting when the SIM read subsequently fails.

**Full-sync reconciliation**: When marking modems as disconnected/absent (lines ~244-252), also clear `sim_read_status`:
```sql
UPDATE modems SET status = 'disconnected', current_iccid = NULL,
  detected_phone_number = NULL, operator = NULL, sim_read_status = NULL
WHERE verification_status = 'pending'
```

### 2.3 Stats update — `device-count.js`

Add `modem_only_count` to the stats query:
```sql
(SELECT COUNT(*) FROM device_view WHERE sim_status = 'modem_only') as modem_only_sims
```

The `modem_only` modems are NOT counted as `active_sims` (correct — the SIM is not provably active). The new count gives the frontend a way to show how many modems have SIM read failures.

---

## Layer 3: API Changes

### 3.1 ICCID Mappings handler

Query `device_view` directly (not sims JOIN device_view, which would be redundant):

```sql
SELECT
  iccid as id, sim_index, number as phone_number, country,
  carrier, equipment_id, notes,
  sim_status as is_active,
  sim_read_status, signal_quality, modem_status,
  created_at, updated_at
FROM device_view
ORDER BY sim_index ASC
```

The `is_active` field now returns `'active'`, `'modem_only'`, or `'inactive'` instead of the previous binary.

### 3.2 Phones handler

No changes — `PhoneList.svelte` already handles the fields it gets. The new `modem_only` status value will be treated as non-active by existing client-side filtering.

### 3.3 Stats handler

Return the new `modem_only_sims` count from `device-count.js`.

---

## Layer 4: Frontend Changes

### 4.1 ICCID Mapping table — New columns

Replace single "状态" column with:

| Column | Field | Display |
|--------|-------|---------|
| **Modem** | `equipment_id` presence + `modem_status` | Green dot + "UP" / Red dot + "DOWN" / Gray "—" |
| **SIM Read** | `sim_read_status` | Green "OK" / Red "FAIL" / Gray "—" |
| **Signal** | `signal_quality` | Percentage with color (green/yellow/red) or "—" |
| **Status** | `sim_status` (summary badge) | Active (green) / Error (amber) / Offline (red) / Inactive (gray) |

### 4.2 Filter tabs

Current: `All` / `Active (N)` / `Inactive (N)`

New: `All (N)` / `Active (N)` / `Error (N)` / `Inactive (N)`

- **Active**: `is_active === 'active'`
- **Error**: `is_active === 'modem_only'` (modem alive, SIM read failed)
- **Inactive**: `is_active === 'inactive'`

Note: Without the Error tab, `modem_only` rows would fall through both existing Active and Inactive filters (since it matches neither `=== 'active'` nor `=== 'inactive'`). The Error tab is required, not optional.

### 4.3 Status badge colors

```
active     → green  (bg-emerald-100 text-emerald-800), label: "Active" / "活动"
modem_only → amber  (bg-amber-100 text-amber-800), label: "Error" / "异常"
inactive   → gray   (bg-gray-100 text-gray-800), label: "Inactive" / "未激活"
```

### 4.4 No changes to other pages

- `PhoneList.svelte` (dashboard): continues using existing fields. `modem_only` treated as non-active.
- `IccidMappingDialog.svelte` (edit modal): no changes needed — status is read-only computed.

---

## Testing Strategy

### Daemon unit tests
- `process_single_modem` with ICCID None but IMEI Some → returns Phone with `sim_read_status: "failed"`
- `process_single_modem` with both ICCID and IMEI None → returns error result
- Startup cache includes IMEI-only modems
- SMS sender reverse cache excludes IMEI-only modems (no ICCID to map)

### API integration tests
- POST `/api/control/devices` with modem having `sim_read_status: "failed"` and no SIM entry → modem row created, `current_iccid` is NULL
- `device_view` returns `sim_status = 'modem_only'` when `sims.imei` matches a modem without ICCID
- Full-sync reconciliation clears `sim_read_status` for absent modems
- Stats endpoint returns `modem_only_sims` count

### Frontend
- Verify multi-indicator columns render correctly for all states (active, modem_only, inactive)
- Filter tabs show correct counts, including Error tab
- `modem_only` rows appear in Error tab, not in Active or Inactive
- Search works across new status values

---

## Migration Safety

- `ALTER TABLE ADD COLUMN` with `DEFAULT NULL` is non-breaking — existing rows get NULL
- UNIQUE index on `sims.imei` — migration handles existing duplicates by clearing all but the lowest `sim_index` entry
- View recreation is idempotent (DROP VIEW IF EXISTS + CREATE VIEW)
- Daemon change is backwards-compatible — server ignores unknown fields, and `sim_read_status` being absent is treated as NULL
- Deploy order: **migration first → server deploy → frontend deploy → daemon deploy** (frontend can deploy any time after server since unknown fields are ignored by the client)
