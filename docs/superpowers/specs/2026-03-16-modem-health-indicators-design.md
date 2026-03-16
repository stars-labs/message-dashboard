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

Previously-seen modems that stop reporting transition to disconnected status via the existing full-sync reconciliation mechanism.

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

### 1.3 `api_client.rs` — Payload includes `sim_read_status`

Add `sim_read_status: String` to the `Modem` struct. Values: `"ok"` or `"failed"`.

The sync payload now includes IMEI-only modems:
```json
{
  "modems": [
    {
      "equipment_id": "861234567890123",
      "manufacturer": "Quectel",
      "model": "EC20",
      "sim_read_status": "failed",
      "current_iccid": null,
      "signal_percent": 65,
      ...
    }
  ],
  "sims": []
}
```

### 1.4 Phone/Sim struct changes

`Phone` struct gains:
- `sim_read_status: String` — `"ok"` or `"failed"`

No changes to `Sim` struct — it's simply not created when ICCID fails.

---

## Layer 2: Database Changes

### 2.1 Migration — Add column

```sql
ALTER TABLE modems ADD COLUMN sim_read_status TEXT DEFAULT NULL;
-- 'ok': ICCID read succeeded
-- 'failed': modem alive, ICCID read failed
-- NULL: legacy data / unknown
```

### 2.2 `control.js` — Store `sim_read_status`

In the modem upsert:
```sql
INSERT INTO modems (equipment_id, ..., sim_read_status, updated_at)
VALUES (?, ..., ?, CURRENT_TIMESTAMP)
ON CONFLICT(equipment_id) DO UPDATE SET
  ..., sim_read_status = excluded.sim_read_status, updated_at = CURRENT_TIMESTAMP
```

No other handler logic changes — IMEI-only modems are already valid rows since `equipment_id` is the PK. The SIM association loop already checks for ICCID presence before updating `current_iccid`, so IMEI-only modems naturally get `current_iccid = NULL`.

### 2.3 `device_view` — Dual join

```sql
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

The `m_imei` join condition `AND m_iccid.equipment_id IS NULL` ensures the IMEI fallback only activates when the primary ICCID-based join didn't match. This prevents double-counting when both paths match the same modem.

---

## Layer 3: API Changes

### 3.1 ICCID Mappings handler

The existing query in `iccid-mappings.js` needs to use the updated `device_view` or replicate the dual-join logic. Since `device_view` already includes all the new fields, the handler just needs to select the new columns:

```sql
SELECT
  s.iccid as id, s.sim_index, s.phone_number, s.country_code as country,
  s.carrier, s.imei as equipment_id, s.notes,
  -- New: use device_view's computed status instead of inline CASE
  dv.sim_status as is_active,
  dv.sim_read_status,
  dv.signal_quality,
  dv.modem_status,
  s.created_at, s.updated_at, s.updated_by
FROM sims s
LEFT JOIN device_view dv ON s.iccid = dv.iccid
ORDER BY s.sim_index ASC
```

Alternatively, query `device_view` directly with the additional columns.

### 3.2 Phones handler

No changes — `PhoneList.svelte` already handles the fields it gets. The new `modem_only` status value will be treated as non-active by existing client-side filtering.

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

- **Active**: `sim_status = 'active'`
- **Error**: `sim_status = 'modem_only'` (modem alive, SIM read failed)
- **Inactive**: `sim_status = 'inactive'`

### 4.3 Status badge colors

```
active     → green  (bg-emerald-100 text-emerald-800)
modem_only → amber  (bg-amber-100 text-amber-800), label: "Error"
inactive   → gray   (bg-gray-100 text-gray-800)
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

### API integration tests
- POST `/api/control/devices` with modem having `sim_read_status: "failed"` and `current_iccid: null` → modem row created
- `device_view` returns `sim_status = 'modem_only'` when `sims.imei` matches a modem without ICCID

### Frontend
- Verify multi-indicator columns render correctly for all 4 states
- Filter tabs show correct counts
- Search works across new status values

---

## Migration Safety

- `ALTER TABLE ADD COLUMN` with `DEFAULT NULL` is non-breaking — existing rows get NULL
- View recreation is idempotent (DROP VIEW IF EXISTS + CREATE VIEW)
- Daemon change is backwards-compatible — server ignores unknown fields, and `sim_read_status` being absent is treated as NULL
- Deploy order: migration first → server deploy → daemon deploy
