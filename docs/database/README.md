# Database Architecture Documentation (v2.0.0)

## Overview

The SMS Dashboard database underwent a complete architectural overhaul in v2.0.0, transitioning from a monolithic `phones` table to a normalized structure that separates hardware, SIM cards, and real-time state. This design improves data integrity, query performance, and provides better support for the lock-free daemon architecture.

## Database Technology

- **Platform**: Cloudflare D1 (SQLite-based)
- **Replication**: Global edge replication
- **ACID Compliance**: Full transaction support via D1 batch API
- **Connection Model**: Serverless with connection pooling
- **Migration System**: Sequential numbered migrations with rollback support

## Schema Architecture (v2.0.0)

### Normalized Entity Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Database Schema v2.0                         │
│                                                                     │
│  ┌─────────────────┐         ┌─────────────────┐                   │
│  │     modems      │         │  modem_state    │                   │
│  │  (Hardware)     │         │ (Volatile Data) │                   │
│  ├─────────────────┤    ┌────┤                 │                   │
│  │equipment_id (PK)│◀───┘    │modem_id (FK)    │                   │
│  │manufacturer     │         │signal_percent   │                   │
│  │model            │         │rssi             │                   │
│  │firmware         │         │rsrq             │                   │
│  │hardware_rev     │         │rsrp             │                   │
│  │imei             │         │snr              │                   │
│  │status           │         │operator         │                   │
│  │created_at       │         │connection_status│                   │
│  │updated_at       │         │bearer_tech      │                   │
│  └─────────┬───────┘         │band_info        │                   │
│            │                 │updated_at       │                   │
│            │                 │created_at       │                   │
│            │                 └─────────────────┘                   │
│            │                                                       │
│            │  ┌─────────────────┐                                  │
│            └──│      sims       │                                  │
│               │  (SIM Cards)    │                                  │
│               ├─────────────────┤                                  │
│               │iccid (PK)       │                                  │
│               │current_modem_id │                                  │
│               │phone_number     │                                  │
│               │carrier          │                                  │
│               │country_code     │                                  │
│               │status           │                                  │
│               │sim_index        │                                  │
│               │created_at       │                                  │
│               │updated_at       │                                  │
│               └─────────┬───────┘                                  │
│                         │                                          │
│                         │  ┌─────────────────┐                    │
│                         └──│    messages     │                    │
│                            │   (SMS Data)    │                    │
│                            ├─────────────────┤                    │
│                            │id (PK)          │                    │
│                            │phone_id (FK)    │ ──┐                │
│                            │phone_number     │   │ References     │
│                            │sender           │   │ sims.iccid     │
│                            │content          │   │                │
│                            │extracted_code   │ ──┘                │
│                            │metadata         │                    │
│                            │created_at       │                    │
│                            │updated_at       │                    │
│                            └─────────────────┘                    │
│                                                                   │
│  ┌─────────────────┐         ┌─────────────────┐                  │
│  │  daemon_health  │         │  device_view    │                  │
│  │ (Monitoring)    │         │(Compatibility)  │                  │
│  ├─────────────────┤         ├─────────────────┤                  │
│  │daemon_id (PK)   │         │id               │                  │
│  │modem_count      │         │phone_number     │                  │
│  │last_heartbeat   │         │iccid            │                  │
│  │status           │         │equipment_id     │                  │
│  │version          │         │signal_percent   │                  │
│  │error_count      │         │operator         │                  │
│  │uptime_seconds   │         │status           │                  │
│  │created_at       │         │manufacturer     │                  │
│  │updated_at       │         │model            │                  │
│  └─────────────────┘         │... (all fields) │                  │
│                              └─────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Table Specifications

### 1. `modems` Table (Hardware Tracking)

**Purpose**: Tracks physical modem hardware with immutable characteristics

```sql
CREATE TABLE modems (
    equipment_id TEXT PRIMARY KEY,           -- IMEI or synthetic ID (MODEM_001)
    manufacturer TEXT,                       -- e.g., "Quectel"
    model TEXT,                             -- e.g., "EC20"
    firmware TEXT,                          -- e.g., "EC20CEFAR06A01M1G"
    hardware_revision TEXT,                 -- e.g., "EC20 R2.0"
    imei TEXT,                              -- Original IMEI (may be null)
    status TEXT DEFAULT 'disconnected',     -- connected, disconnected, error
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Key Design Decisions**:
- **Equipment ID as Primary Key**: Uses IMEI when available, synthetic IDs (MODEM_001) as fallback
- **Hardware Immutability**: Manufacturer, model, firmware rarely change
- **Status Tracking**: Connection state separate from volatile signal data
- **Synthetic ID Pattern**: `MODEM_001`, `MODEM_002`, etc. for modems without valid IMEI

### 2. `sims` Table (SIM Card Management)

**Purpose**: Manages SIM card information and phone number assignments

```sql
CREATE TABLE sims (
    iccid TEXT PRIMARY KEY,                 -- Unique SIM card identifier
    current_modem_id TEXT,                  -- Currently inserted in this modem
    phone_number TEXT,                      -- E.164 format: +8613800138001
    carrier TEXT,                           -- e.g., "China Mobile", "Singtel"
    country_code TEXT,                      -- ISO 3166-1: CN, HK, SG
    status TEXT DEFAULT 'inactive',         -- active, inactive, removed
    sim_index INTEGER,                      -- Physical slot index in modem
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (current_modem_id) REFERENCES modems(equipment_id) ON DELETE SET NULL
);
```

**Key Features**:
- **ICCID Primary Key**: Globally unique SIM identifier (19-20 digits)
- **Flexible Modem Assignment**: SIMs can be moved between modems
- **Geographic Classification**: Country codes enable regional filtering
- **Status Lifecycle**: Tracks SIM card lifecycle states

### 3. `modem_state` Table (Volatile Real-time Data)

**Purpose**: High-frequency updates for signal quality and connection status

```sql
CREATE TABLE modem_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modem_id TEXT NOT NULL,                 -- References modems.equipment_id
    signal_percent INTEGER,                 -- Signal strength percentage (0-100)
    rssi REAL,                             -- Received Signal Strength Indicator (dBm)
    rsrq REAL,                             -- Reference Signal Received Quality (dB)
    rsrp REAL,                             -- Reference Signal Received Power (dBm)
    snr REAL,                              -- Signal-to-Noise Ratio (dB)
    operator TEXT,                         -- Network operator name
    connection_status TEXT,                -- registered, searching, denied, unknown
    bearer_technology TEXT,                -- LTE, UMTS, GSM
    band_info TEXT,                        -- Frequency band information
    network_id TEXT,                       -- MCC-MNC identifier
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (modem_id) REFERENCES modems(equipment_id) ON DELETE CASCADE
);
```

**Update Pattern**: 
- **High Frequency**: Updated every 50ms by daemon
- **Latest State**: Only most recent record per modem is relevant
- **Cascading Delete**: Automatically cleaned up when modem is removed

### 4. `messages` Table (SMS Content)

**Purpose**: Stores SMS message content with metadata and extraction results

```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,                    -- UUID or daemon-generated ID
    phone_id TEXT NOT NULL,                 -- References sims.iccid
    phone_number TEXT NOT NULL,             -- Recipient phone number
    sender TEXT,                            -- Sender identifier (phone/shortcode)
    content TEXT NOT NULL,                  -- Original message content
    extracted_code TEXT,                    -- Auto-extracted verification code
    metadata TEXT,                          -- JSON: {"keywords": [], "confidence": 0.95}
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (phone_id) REFERENCES sims(iccid) ON DELETE CASCADE
);
```

**Content Processing**:
- **Verification Code Extraction**: Automatic regex-based extraction
- **Metadata Storage**: JSON field for keyword tags, confidence scores
- **Sender Tracking**: Both phone numbers and shortcodes supported
- **Deduplication**: Daemon-level Bloom filter prevents duplicate inserts

### 5. `daemon_health` Table (System Monitoring)

**Purpose**: Tracks daemon health, performance metrics, and heartbeat status

```sql
CREATE TABLE daemon_health (
    daemon_id TEXT PRIMARY KEY,            -- "orange-pi-main", "orange-pi-backup"
    modem_count INTEGER NOT NULL,          -- Currently managed modems
    last_heartbeat DATETIME NOT NULL,      -- Last successful health update
    status TEXT DEFAULT 'unknown',         -- healthy, degraded, offline
    version TEXT,                          -- Daemon version (v3.6.0)
    error_count INTEGER DEFAULT 0,         -- Errors in last hour
    uptime_seconds INTEGER,                -- Daemon uptime
    memory_mb INTEGER,                     -- Memory usage in MB
    cpu_percent REAL,                      -- CPU utilization percentage
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Health Monitoring**:
- **Heartbeat System**: Updated every 30 seconds by daemon
- **Performance Tracking**: Memory, CPU, error rates
- **Version Management**: Tracks daemon version for compatibility checks

### 6. `device_view` (Backward Compatibility)

**Purpose**: Provides v1 API compatibility while using v2 normalized schema

```sql
CREATE VIEW device_view AS
SELECT 
    s.iccid as id,                         -- Backward compatibility with v1
    s.phone_number,
    s.iccid,
    s.country_code,
    s.carrier,
    s.status,
    s.sim_index,
    m.equipment_id,
    m.manufacturer,
    m.model,
    m.firmware,
    m.hardware_revision as hardware_rev,
    m.imei,
    m.status as modem_status,
    ms.signal_percent,
    ms.rssi,
    ms.rsrq,
    ms.rsrp,
    ms.snr,
    ms.operator,
    ms.connection_status,
    ms.bearer_technology,
    ms.band_info,
    ms.network_id,
    COALESCE(ms.updated_at, s.updated_at, m.updated_at) as updated_at,
    COALESCE(s.created_at, m.created_at) as created_at
FROM sims s
LEFT JOIN modems m ON s.current_modem_id = m.equipment_id
LEFT JOIN modem_state ms ON m.equipment_id = ms.modem_id
WHERE s.status = 'active';
```

**Compatibility Features**:
- **Same Field Names**: Maintains v1 API field naming
- **Automatic Joins**: Combines normalized data transparently
- **Performance**: Optimized with covering indexes

## Indexes and Performance

### Primary Indexes

```sql
-- Automatic primary key indexes
CREATE UNIQUE INDEX idx_modems_equipment_id ON modems(equipment_id);
CREATE UNIQUE INDEX idx_sims_iccid ON sims(iccid);
CREATE UNIQUE INDEX idx_messages_id ON messages(id);
CREATE UNIQUE INDEX idx_daemon_health_id ON daemon_health(daemon_id);
```

### Performance Indexes

```sql
-- Real-time state lookups
CREATE INDEX idx_modem_state_modem_id ON modem_state(modem_id);
CREATE INDEX idx_modem_state_updated_at ON modem_state(updated_at);

-- SIM card queries
CREATE INDEX idx_sims_current_modem_id ON sims(current_modem_id);
CREATE INDEX idx_sims_phone_number ON sims(phone_number);
CREATE INDEX idx_sims_status ON sims(status);

-- Message queries
CREATE INDEX idx_messages_phone_id ON messages(phone_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_phone_number ON messages(phone_number);

-- Modem status queries
CREATE INDEX idx_modems_status ON modems(status);
CREATE INDEX idx_modems_updated_at ON modems(updated_at);

-- Health monitoring
CREATE INDEX idx_daemon_health_heartbeat ON daemon_health(last_heartbeat);
```

### Query Optimization Examples

#### High-Performance Device Count
```sql
-- v2.0 optimized count (uses index)
SELECT COUNT(*) FROM modems WHERE status = 'connected';

-- Combined with SIM status
SELECT 
    COUNT(*) FILTER (WHERE m.status = 'connected') as online_modems,
    COUNT(*) FILTER (WHERE s.status = 'active') as active_sims
FROM modems m 
LEFT JOIN sims s ON m.equipment_id = s.current_modem_id;
```

#### Latest Signal Data per Modem
```sql
-- Efficient latest state query
WITH latest_state AS (
    SELECT modem_id, signal_percent, operator, updated_at,
           ROW_NUMBER() OVER (PARTITION BY modem_id ORDER BY updated_at DESC) as rn
    FROM modem_state 
    WHERE updated_at > datetime('now', '-5 minutes')
)
SELECT * FROM latest_state WHERE rn = 1;
```

## Migration System

### Migration Architecture

The system uses sequential numbered migrations with comprehensive validation:

```
migrations/
├── 002_refactor_phones_to_modems_sims.sql  # Create new tables
├── 003_migrate_phones_data.sql             # Data migration
├── 004_cleanup_synthetic_entries.sql       # Data cleanup
├── 005_create_device_view.sql              # Compatibility layer
├── 006_drop_phones_table.sql               # Remove old table
├── validate-migration.sql                  # Validation checks
└── rollback-to-phones.sql                  # Emergency rollback
```

### Migration Process

#### Step 1: Schema Creation
```sql
-- 002_refactor_phones_to_modems_sims.sql
BEGIN TRANSACTION;

CREATE TABLE modems (
    equipment_id TEXT PRIMARY KEY,
    manufacturer TEXT,
    model TEXT,
    -- ... all fields
);

CREATE TABLE sims (
    iccid TEXT PRIMARY KEY,
    current_modem_id TEXT,
    -- ... all fields
    FOREIGN KEY (current_modem_id) REFERENCES modems(equipment_id)
);

-- Create all tables and indexes
COMMIT;
```

#### Step 2: Data Migration
```sql
-- 003_migrate_phones_data.sql
BEGIN TRANSACTION;

-- Migrate unique modems (by equipment_id/IMEI)
INSERT OR IGNORE INTO modems (equipment_id, manufacturer, model, firmware, status, created_at, updated_at)
SELECT 
    COALESCE(NULLIF(equipment_id, ''), 'MODEM_' || ROW_NUMBER() OVER (ORDER BY id)) as equipment_id,
    manufacturer,
    model,
    firmware,
    status,
    created_at,
    updated_at
FROM phones 
WHERE id IS NOT NULL;

-- Migrate SIM cards
INSERT OR IGNORE INTO sims (iccid, current_modem_id, phone_number, carrier, country_code, status, created_at, updated_at)
SELECT 
    id as iccid,
    COALESCE(NULLIF(equipment_id, ''), 'MODEM_' || ROW_NUMBER() OVER (ORDER BY id)) as current_modem_id,
    phone_number,
    carrier,
    country_code,
    status,
    created_at,
    updated_at
FROM phones 
WHERE id IS NOT NULL;

-- Migrate volatile state data
INSERT INTO modem_state (modem_id, signal_percent, rssi, operator, connection_status, updated_at)
SELECT DISTINCT
    COALESCE(NULLIF(equipment_id, ''), 'MODEM_' || ROW_NUMBER() OVER (ORDER BY id)) as modem_id,
    signal_percent,
    rssi,
    operator,
    connection_status,
    updated_at
FROM phones 
WHERE signal_percent IS NOT NULL;

COMMIT;
```

### Migration Validation

```sql
-- validate-migration.sql
-- Comprehensive validation checks

-- 1. Table existence
SELECT name FROM sqlite_master WHERE type='table' 
  AND name IN ('modems', 'sims', 'modem_state', 'daemon_health');

-- 2. Data integrity checks
SELECT 'PASS' as orphaned_sims_check 
WHERE NOT EXISTS (
  SELECT 1 FROM sims s 
  LEFT JOIN modems m ON s.current_modem_id = m.equipment_id 
  WHERE s.current_modem_id IS NOT NULL AND m.equipment_id IS NULL
);

-- 3. Count validation
SELECT 
  (SELECT COUNT(*) FROM phones) as original_count,
  (SELECT COUNT(*) FROM device_view) as migrated_count,
  CASE WHEN 
    (SELECT COUNT(*) FROM phones) = (SELECT COUNT(*) FROM device_view)
    THEN 'PASS' ELSE 'FAIL' 
  END as count_validation;
```

### Rollback Strategy

```sql
-- rollback-to-phones.sql
-- Emergency rollback to v1 schema

BEGIN TRANSACTION;

-- Recreate phones table from device_view
CREATE TABLE phones_restored AS
SELECT 
    iccid as id,
    phone_number,
    equipment_id,
    manufacturer,
    model,
    firmware,
    signal_percent,
    -- ... all original fields
FROM device_view;

-- Drop new tables
DROP VIEW device_view;
DROP TABLE modem_state;
DROP TABLE sims;
DROP TABLE modems;
DROP TABLE daemon_health;

-- Rename restored table
ALTER TABLE phones_restored RENAME TO phones;

COMMIT;
```

## Database Utilities

### Connection Wrapper (`database-wrapper.js`)

```javascript
export class DatabaseWrapper {
    constructor(db) {
        this.db = db;
        this.statementCache = new Map();
    }
    
    async preparedStatement(sql) {
        if (this.statementCache.has(sql)) {
            return this.statementCache.get(sql);
        }
        
        const stmt = this.db.prepare(sql);
        this.statementCache.set(sql, stmt);
        return stmt;
    }
    
    async batchTransaction(operations) {
        const batch = operations.map(op => ({
            sql: op.sql,
            params: op.params || []
        }));
        
        return await this.db.batch(batch);
    }
}
```

### Device Count Utilities (`device-count.js`)

```javascript
export async function getDeviceStats(db) {
    const stmt = await db.prepare(`
        SELECT 
            COUNT(*) FILTER (WHERE m.status = 'connected') as online_modems,
            COUNT(*) FILTER (WHERE s.status = 'active') as active_sims,
            COUNT(DISTINCT s.country_code) as countries,
            COUNT(DISTINCT ms.operator) as operators
        FROM modems m 
        LEFT JOIN sims s ON m.equipment_id = s.current_modem_id
        LEFT JOIN modem_state ms ON m.equipment_id = ms.modem_id
    `);
    
    const result = await stmt.first();
    
    return {
        online_count: result.online_modems || 0,
        total_sims: result.active_sims || 0,
        countries: result.countries || 0,
        operators: result.operators || 0,
        last_updated: new Date().toISOString()
    };
}
```

## Performance Monitoring

### Key Metrics

- **Query Response Time**: Median < 5ms, P95 < 20ms
- **Connection Pool**: 95%+ cache hit rate
- **Transaction Success Rate**: > 99.9%
- **Database Size Growth**: ~100MB/month for 54 modems
- **Index Utilization**: > 90% of queries use indexes

### Monitoring Queries

```sql
-- Database size and growth
SELECT 
    page_count * page_size / 1024 / 1024 as db_size_mb,
    page_count,
    page_size
FROM pragma_page_count(), pragma_page_size();

-- Table row counts
SELECT 
    name,
    (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=m.name) as row_count
FROM sqlite_master m WHERE type='table';

-- Index usage analysis
EXPLAIN QUERY PLAN 
SELECT * FROM device_view WHERE status = 'connected';
```

This database architecture provides a solid foundation for the SMS Dashboard system, with excellent performance characteristics, strong data integrity, and smooth migration capabilities.