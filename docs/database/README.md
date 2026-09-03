# Database Schema

**Platform**: Cloudflare D1 (SQLite-based, global edge replication)

## Data Flow

```
Orange Pi (Rust Daemon)                  Cloudflare Workers API             Browser (Svelte)
───────────────────────                  ──────────────────────             ────────────────
USB Modems → AT Commands                 /api/control/* (API key)           /api/phones
                                         /api/messages  (API key)           /api/messages
                                                                            /api/iccid-mappings
```

### Who writes what

| Table | Written by | Mechanism |
|-------|-----------|-----------|
| `modems` | Daemon | `POST /api/control/devices` — changed hardware state and USB-confirmed removals only |
| `sims` | Human | Via `/api/iccid-mappings`; the daemon never writes inventory |
| `messages` | Daemon | `POST /api/control/messages` — batch uploads SMS from modems |
| `daemon_health` | Daemon | `POST /api/control/heartbeat` — one health snapshot every 60s |
| `modem_sim_history` | DB trigger | `sim_swap_detection` trigger fires automatically on SIM reassignment |
| `keyword_tags` | Human | Frontend: configure keyword matching rules |
| `message_tags` | Server (auto) | Auto-tagged when messages arrive, matched against `keyword_tags` |
| `audit_logs` | Server | Logged on write operations |

### Key data flow notes

- **SIM phone numbers are mostly NULL** for Singapore SIMs (Singtel/M1). These operators do not provision the MSISDN on the SIM itself, so AT+CNUM returns empty. The daemon cannot read the number automatically.
- **`sims.user_*` columns are the manual override** — `user_phone_number`, `user_carrier`, `user_country_code`, `user_notes`, `user_override_enabled`. The frontend "ICCID Mappings" page reads/writes these columns directly via the `iccid-mappings.js` handler querying `sims`. The old `iccid_mappings` table was dropped in migration 015.
- **`device_view` is the primary read path** — never query `modems`/`sims`/`modem_state` directly from the frontend. The view joins all three and applies user overrides.
- **Messages have no enforced FK** on `phone_iccid → sims.iccid` (dropped in migration 009). Messages can arrive for ICCIDs not yet in `sims`.
- **Daemon is the source of truth** for hardware state. The DB reflects what the daemon last reported; stale DB data (e.g. modems offline for weeks still showing `active`) is a known issue (see ISSUES.md #2).

## Entity Relationship

```
modems (98)
  └── sims (98)               Assigned by sims.imei → modems.equipment_id
        └── messages (8.4k)   phone_iccid → sims.iccid (implicit)

daemon_health (1)             Latest process and task health snapshot

keyword_tags (10)             Keyword → tag/color config
  └── message_tags            FK: keyword_tag_id, message_id

audit_logs                    User action audit trail
schema_version (4)            Migration tracking
```

## Core Tables

### modems
Physical modem hardware. PK is `equipment_id` (IMEI).

```sql
CREATE TABLE modems (
    equipment_id TEXT PRIMARY KEY,
    manufacturer TEXT,
    model TEXT,
    firmware_revision TEXT,
    hardware_revision TEXT,
    device_path TEXT,
    usb_port INTEGER,
    modem_index INTEGER,
    status TEXT DEFAULT 'disconnected',   -- connected | disconnected | error
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    verification_status TEXT DEFAULT 'unverified',
    last_verified_session TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP  -- auto-updated via trigger
);
```

### sims
SIM cards. PK is `iccid`. Supports user overrides for phone number, carrier, and country.

```sql
CREATE TABLE sims (
    iccid TEXT PRIMARY KEY,
    phone_number TEXT,
    country_code TEXT,
    carrier TEXT,
    operator_name TEXT,
    operator_id TEXT,
    current_modem_id TEXT,                -- FK → modems.equipment_id
    status TEXT DEFAULT 'inactive',       -- active | inactive
    sim_index INTEGER,
    activation_date TIMESTAMP,
    deactivation_date TIMESTAMP,
    -- User override fields (applied in device_view when enabled)
    user_phone_number TEXT,
    user_carrier TEXT,
    user_country_code TEXT,
    user_notes TEXT,
    user_override_enabled BOOLEAN DEFAULT FALSE,
    user_updated_at TIMESTAMP,
    user_updated_by TEXT,
    last_verified_session TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP  -- auto-updated via trigger
);
```

**Trigger**: `sim_swap_detection` — automatically logs to `modem_sim_history` when `current_modem_id` changes.

### modem_state
Volatile signal/connection data. One row per modem (PK: `modem_id`).

```sql
CREATE TABLE modem_state (
    modem_id TEXT PRIMARY KEY,            -- FK → modems.equipment_id
    signal_percent INTEGER,
    rssi INTEGER,
    rsrq INTEGER,
    rsrp INTEGER,
    snr INTEGER,
    network_type TEXT,
    access_tech TEXT,
    connection_status TEXT,               -- registered | searching | denied
    modem_index INTEGER,
    usb_port TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP  -- auto-updated via trigger
);
```

### messages
SMS messages. Supports both sent and received.

```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    phone_iccid TEXT,                     -- SIM that sent/received
    phone_number TEXT,
    content TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    type TEXT CHECK(type IN ('sent', 'received')),
    status TEXT,
    recipient TEXT,
    verification_code TEXT,               -- Auto-extracted OTP codes
    sms_id TEXT,                          -- ModemManager SMS ID
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### daemon_health
Single row, updated every 60s by daemon heartbeat.

```sql
CREATE TABLE daemon_health (
    daemon_id TEXT PRIMARY KEY,           -- e.g. "orange-pi-001"
    last_heartbeat TIMESTAMP NOT NULL,
    status TEXT DEFAULT 'online',
    last_ip TEXT,
    version TEXT,
    modem_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    metadata TEXT,                        -- JSON
    current_session_id TEXT,
    last_full_sync TIMESTAMP,
    sync_mode TEXT DEFAULT 'incremental',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Views

### device_view
**Primary view for all device queries.** Joins modems + sims + modem_state. Applies user overrides when enabled. Ordered by USB port.

Key computed fields:
- `status`: online | registered | sim-missing | offline | error (derived from modem + SIM + connection state)
- `number`, `carrier`, `country`: uses user overrides when `user_override_enabled = TRUE`
- `flag`: country flag emoji

### device_stats
Aggregate counts: total/connected modems, total/active SIMs, online devices, avg signal strength.

### sims_with_current_index
SIMs enriched with modem_state data (usb_port, signal, connection_status). Falls back to `modem_index` when `sim_index` is null.

## Feature Tables

### keyword_tags + message_tags
Keyword-based message tagging system. `keyword_tags` defines rules (keyword, tag, color, priority). `message_tags` is the join table recording matches.

### modem_sim_history
SIM swap log — automatically populated by the `sim_swap_detection` trigger on the `sims` table.

## Other Tables

### audit_logs
User action audit trail (action, resource, user email, IP, timestamp).

### schema_version
Migration version tracking.

## Key Indexes

Performance-critical indexes:
- `idx_modem_state_lookup` — `(modem_id, updated_at DESC)` for latest state
- `idx_sims_active_modem` — `(current_modem_id, status) WHERE status = 'active'` for device_view
- `idx_messages_normalized_timestamp_type` — `(timestamp, type)` for message queries
- `idx_messages_normalized_verification` — partial index on non-null verification codes
- `idx_sims_user_override` — partial index for override-enabled SIMs

## Triggers

| Trigger | Table | Action |
|---------|-------|--------|
| `update_modems_timestamp` | modems | Auto-update `updated_at` on any change |
| `update_sims_timestamp` | sims | Auto-update `updated_at` on any change |
| `update_modem_state_timestamp` | modem_state | Auto-update `updated_at` on any change |
| `sim_swap_detection` | sims | Log to `modem_sim_history` when `current_modem_id` changes |
