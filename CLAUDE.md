# CLAUDE.md
All docs in ./docs/ folder
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a distributed SMS management system with three main components:

1. **Web Dashboard** (`sms-dashboard/`) - Real-time SMS management interface
   - Frontend: Svelte + TailwindCSS with Vite build system
   - Backend: Cloudflare Workers with custom routing
   - Database: Cloudflare D1 (SQLite) with normalized schema
   - Real-time: WebSocket + SSE fallback with Durable Objects
   - Auth: Auth0 integration with RBAC
   - Utilities: Centralized database management, API responses, and device counting

2. **SMS Collection Daemon** (`orange-pi-daemon-rust/`) - Rust daemon for hardware integration (v1.0.1)
   - **Technology**: Rust with tokio async runtime and reqwest HTTP client
   - **Reliability**: Memory-safe with no segfaults, robust error handling
   - **Concurrency**: Async/await pattern for concurrent modem processing (batches of 20)
   - **ModemManager Integration**: Direct mmcli subprocess calls via tokio::process
   - **Features**:
     - Full modem discovery and state tracking
     - SMS message collection and forwarding to API
     - Signal quality monitoring
     - Device details extraction (IMEI, manufacturer, model, firmware)
     - Correct timestamp parsing for ISO 8601 with timezone offsets
   - **Performance**: Handles 87 modems with ~95-105s cycle time, 8M memory usage
   - **Stability**: Zero crashes, replaces unreliable Zig daemon (persistent segfaults)

3. **NixOS Configuration** (`nixos-config/`) - Declarative system deployment
   - Flake-based NixOS configuration for Orange Pi
   - SMS daemon service definition and modem support
   - Secrets management with SOPS

### Database Architecture (v2.0)

The system has been refactored from a monolithic `phones` table to a normalized structure:

- **`modems`** - Hardware tracking (IMEI/equipment_id as primary key)
- **`sims`** - SIM card data (ICCID as primary key)
- **`modem_state`** - Real-time modem status (volatile data)
- **`daemon_health`** - Daemon monitoring and heartbeat tracking
- **`device_view`** - Backward compatibility view combining all tables

## Development Commands

### Frontend Development
```bash
cd sms-dashboard
npm install
npm run dev          # Vite dev server (localhost:5173)
npm run dev:api      # Wrangler dev server for API testing
npm run build        # Production build
npm run preview      # Preview production build
```

### Backend/API Development
```bash
cd sms-dashboard
npm run dev:api                    # Local Workers development
npx wrangler tail sms-dashboard    # Live production logs
npx wrangler dev --remote          # Dev against remote D1/KV
```

### Database Operations
```bash
cd sms-dashboard
npm run db:init                    # Initialize local D1 database
npm run db:migrate                 # Run migrations on remote database

# Manual D1 operations
npx wrangler d1 execute sms-dashboard --local --file=path/to/file.sql
npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"

# Migration validation
npx wrangler d1 execute sms-dashboard --remote --file=migrations/validate-migration.sql
node scripts/validate-migration.js  # Automated validation

# Rollback if needed
npx wrangler d1 execute sms-dashboard --remote --file=migrations/rollback-to-phones.sql
```

### SMS Daemon (Zig)
```bash
cd orange-pi-daemon
zig build -Doptimize=ReleaseFast -Dlog_level=info  # Production build
zig build -Doptimize=Debug -Dlog_level=debug       # Debug build
export SMS_API_URL="https://sexy.qzz.io"
export SMS_API_KEY="your-api-key"
./zig-out/bin/orange-pi-daemon                     # Run daemon
```

### NixOS Deployment
```bash
# Deploy to Orange Pi (critical command - often forgotten)
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@10.171.150.102 --build-host root@10.171.150.102 \
    --impure

# Check daemon status on Orange Pi
ssh root@10.171.150.102 'systemctl status sms-dashboard-daemon'
```

### Production Deployment
```bash
cd sms-dashboard
npm run deploy      # Build unified bundle and deploy to Cloudflare
```

## Key Technical Patterns

### Frontend Architecture
- **Component Structure**: Reactive Svelte 5 components with stores
- **API Integration**: `lib/api.js` provides typed API client
- **Real-time Updates**: WebSocket with SSE fallback (`lib/websocket-with-fallback.js`)
- **Authentication**: Auth0 integration in `lib/auth.js`
- **State Management**: Svelte stores for phones, messages, user state

### Backend Architecture
- **Custom Router**: Simple router implementation (not itty-router) in `server/index.js`
- **Middleware Chain**: CORS → Auth0 → RBAC → Handler pattern
- **API Authentication**: Dual auth system - Auth0 for users, API key for Orange Pi
- **Database Layer**: Direct D1 SQL queries with prepared statements
- **WebSocket**: Durable Objects for connection persistence and broadcasting
- **Utilities**:
  - `server/utils/database-setup.js` - Table creation and index management
  - `server/utils/device-count.js` - Centralized device statistics
  - `server/utils/api-response.js` - Standardized API responses
  - `server/utils/database-wrapper.js` - D1 connection wrapper with statement caching

### Data Flow
```
Orange Pi → mmcli → Zig Daemon → API (API Key) → D1 Database → WebSocket Broadcast → Frontend
                                      ↓
                              User Auth (Auth0) → Protected API → Frontend
```

### Database Schema Critical Points

#### Normalized Schema (v2.1 - September 2025)
The database has been fully normalized to strict 3NF compliance:

- **Core Tables**:
  - `modems` - Hardware devices (Primary Key: `equipment_id` - IMEI)
  - `sims` - SIM cards with user overrides (Primary Key: `iccid`)
  - `modem_state` - Real-time modem status (Foreign Key: `modem_id`)
  - `messages` - SMS messages (Foreign Key: `phone_iccid` → `sims.iccid`)
  - `daemon_health` - Daemon monitoring and heartbeat

- **User Override Pattern**:
  - User phone number overrides stored directly in `sims` table
  - Fields: `user_phone_number`, `user_carrier`, `user_country_code`, `user_notes`
  - Flag: `user_override_enabled` to activate overrides
  - Maintains 3NF - no transitive dependencies

- **Deprecated Tables Removed**:
  - `iccid_mappings` - Replaced by user override fields in `sims`
  - `messages_old_backup` - Removed after successful migration
  - Database size reduced by 79% (5.31MB → 1.09MB)

- **View for Compatibility**:
  - `device_view` - Combines all tables for backward compatibility
  - Automatically uses user overrides when enabled
  - USB port ordering support via `modem_state.usb_port`

## Common Issues & Debugging

### Wrangler Authentication Errors
If you see `Authentication error [code: 10000]` when running wrangler commands:
```bash
npx wrangler login
```
This will open a browser for OAuth authentication. Always fix authentication issues first before debugging other problems.

### Frontend Crashes
- Null ID handling: Always check `phone.id && phone.id.length` before calling `.slice()`
- Search filters: Verify `.toLowerCase()` availability before calling

### Backend Data Issues
```bash
# Monitor API calls causing issues
npx wrangler tail sms-dashboard --format pretty

# Check for data inconsistencies
npx wrangler d1 execute sms-dashboard --command "SELECT * FROM device_stats" --remote

# Verify device counts match
node scripts/test-stats-api.js

# Clean up stale modem states (older than 2 minutes)
npx wrangler d1 execute sms-dashboard --command "UPDATE modems SET status = 'disconnected' WHERE datetime(updated_at) < datetime('now', '-2 minutes') AND status = 'connected'" --remote

# Check daemon health
npx wrangler d1 execute sms-dashboard --command "SELECT *, datetime(last_heartbeat) as heartbeat_time FROM daemon_health ORDER BY last_heartbeat DESC" --remote
```

### SMS Daemon Issues
- Check ModemManager status: `systemctl status ModemManager`
- Verify modem detection: `mmcli -L`
- Check ICCID extraction: `mmcli -m [modem_id]` then `mmcli -i [sim_id]`
- Check modem details: `mmcli -m [modem_id] | grep -E "(manufacturer|model|firmware|equipment)"` 
- Monitor daemon logs: `journalctl -u sms-daemon -f`
- Check for deadlocks: `journalctl -u sms-daemon | grep -E '(deadlock|panic)'`

### Daemon Performance Metrics (v3.4.0)
- **Target Performance**:
  - Cycle time: 50ms per check cycle
  - Worker threads: 8 parallel processors
  - Typical: 54 modems checked in ~100ms
  - Memory usage: ~50MB for 54 modems
  - CPU usage: ~20% with 54 modems on 8-core CPU
- **Lock-Free Guarantees**:
  - No mutexes or locks in critical paths
  - All shared data uses atomic operations
  - MPMC queues handle up to 8192 items
  - Signal cache: 256 entries with hash-based lookup
  - Priority manager: 256 modem slots
- **HTTP Communication**:
  - Native Zig std.http.Client
  - Connection pooling for efficiency
  - Timeout: 10s connection, 10s read
- **Memory Management**:
  - All allocations use defer for cleanup
  - Arena allocators for batch operations
  - Zero memory leaks in production

### Auth0 Configuration
- Callback URLs must include both development and production domains
- JWT verification requires proper audience and issuer configuration
- RBAC permissions: `phones.read`, `messages.read`, `messages.send`

## Environment Variables & Secrets

### Wrangler Secrets (set with `wrangler secret put`)
```bash
AUTH0_DOMAIN          # tenant.auth0.com
AUTH0_CLIENT_ID       # Auth0 application client ID
AUTH0_CLIENT_SECRET   # Auth0 application client secret
AUTH0_AUDIENCE        # API audience (optional)
API_KEY              # Orange Pi authentication key
```

### Orange Pi Environment
```bash
SMS_API_URL="https://sexy.qzz.io"
SMS_API_KEY="api-key-from-wrangler-secrets"
```

## Testing & Monitoring

### API Testing
```bash
# Test phone data upload
node scripts/test-phone-data.js

# Health check
curl https://sexy.qzz.io/api/health

# Test with auth
curl -H "Authorization: Bearer $TOKEN" https://sexy.qzz.io/api/phones
```

### Database Monitoring
```bash
# Check device statistics
npx wrangler d1 execute sms-dashboard --command "SELECT * FROM device_stats" --remote

# Monitor modem/SIM status
npx wrangler d1 execute sms-dashboard --command "SELECT status, COUNT(*) FROM modems GROUP BY status" --remote
npx wrangler d1 execute sms-dashboard --command "SELECT status, COUNT(*) FROM sims GROUP BY status" --remote

# Recent messages
npx wrangler d1 execute sms-dashboard --command "SELECT * FROM messages ORDER BY created_at DESC LIMIT 10" --remote

# Check for phantom modems (connected but no recent update)
npx wrangler d1 execute sms-dashboard --command "SELECT equipment_id, status, datetime(updated_at) as last_update FROM modems WHERE status = 'connected' AND datetime(updated_at) < datetime('now', '-60 seconds')" --remote

# Performance statistics
npx wrangler d1 execute sms-dashboard --command "SELECT COUNT(*) as state_records, AVG(signal_percent) as avg_signal FROM modem_state" --remote
```

## Critical System Dependencies

### Orange Pi Hardware Requirements
- ModemManager 1.18+ for modem interface
- USB 3.0 hubs with external power (12V 10A+ recommended for 50+ modems)
- Tested with 54+ Quectel EC20 modems simultaneously
- Minimum 8GB RAM for high modem counts
- Multi-core CPU (8+ cores recommended) for parallel processing
- ICCID extraction via mmcli SIM path parsing

### Cloudflare Services Used
- Workers (backend hosting)
- D1 (SQLite database)
- KV (session storage)
- Durable Objects (WebSocket persistence)
- Custom domain routing

### Build System
- Vite for frontend bundling
- Custom `build-unified.js` script combines frontend assets into Workers
- TailwindCSS for styling
- Bun as package manager and runtime

## Recent Changes (October 2025)

### v1.0.1 - Rust Daemon Timestamp Fix (October 6, 2025)
- **Critical Bug Fix**: Corrected timestamp parsing in Rust daemon
  - **Problem**: Timestamps like "2025-10-05T19:05:4208" instead of "2025-10-05T19:05:42+08:00"
  - **Root Cause**: String slicing approach was cutting off timezone offset
  - **Solution**: Changed from `line[idx + 10..]` to `line[colon_pos + 1..].trim()` using `find(':')`
  - Fixed 500 Internal Server Errors caused by malformed timestamps
  - Commit: `51c4f69` - successfully deployed to production
- **Result**: Zero API errors, all 87 modems uploading correctly
- **Stability**: Daemon running stable for hours, no crashes or memory leaks

### v1.0.0 - Rust Daemon Migration (October 2-5, 2025)
- **Complete Rewrite**: Migrated from Zig to Rust to eliminate persistent segfaults
  - Zig daemon: Frequent `0xaaaaaaaaaaaaaaba` crashes (memory corruption)
  - Rust daemon: Zero segfaults, memory-safe by design
- **DNS Resolution Fix (October 5)**: Fixed DNSSEC validation failures
  - Problem: systemd-resolved failing DNSSEC validation
  - Solution: Disabled DNSSEC in NixOS (`services.resolved.dnssec = "false"`)
  - Daemon now successfully connects to API
- **Architecture**:
  - Async/await with tokio multi-threaded runtime (4 worker threads)
  - reqwest HTTP client with 10s timeouts
  - Direct mmcli integration via tokio::process::Command  
  - Concurrent modem processing (batches of 20)
  - Clean module structure: main, api_client, modem_manager, types
- **Performance**: 
  - 87 modems, 95-105s cycle time
  - Memory: 8M typical, 44.4M peak
  - CPU: ~2min per cycle
  - Zero crashes in extended operation
- **Deployment**: NixOS flake with systemd service integration

### v2.1.0 - Database Normalization to 3NF (September 2025)

### v1.15.0 - Fixed API Field Mapping
- Fixed PendingSms struct to match API response fields
- Fixed api_client.zig field name mapping (pending_messages not pending_sms)
- Updated sms_sender.zig to use correct field names (recipient, phone_iccid)
- Removed Content-Length header that was causing 400 errors
- All HTTP uploads now working correctly

### v1.14.0 - Native Zig HTTP Client
- Use Zig's std.http.Client instead of curl subprocess
- Proper timeout handling with connection_timeout and read_timeout
- More efficient memory usage without temp files
- Better error handling and connection pooling

### v1.1.1 - HTTP Client Migration (Deprecated)
- Replaced Zig's native HTTP client with curl subprocess calls
- Fixed "Failed to write payload: error.NotWriteable" errors
- Improved reliability of message uploads and phone status updates
- Added comprehensive logging for HTTP request/response debugging

### Architecture Update
- Daemon now uses HTTP POST requests to upload data (not WebSocket)
- Server broadcasts updates via WebSocket/SSE to connected clients
- API endpoints: `/api/control/phones` and `/api/control/messages`

### v1.16.0 - Keyword Highlighting & Tagging System (August 2025)
- **Database Schema**: Added `keyword_tags` and `message_tags` tables for keyword-tag mappings
- **API Endpoints**: 
  - `/api/keywords` - CRUD operations for keyword configuration
  - `/api/messages/:id/tags` - Get tags for a specific message
  - `/api/ai/analyze-keywords` - AI analysis of keyword usage and patterns
- **UI Components**:
  - `KeywordConfig.svelte` - Configuration interface for managing keywords
  - `MessageHighlight.svelte` - Real-time message highlighting with tags
  - Added "Keywords" tab to main navigation
- **Features**:
  - Case-sensitive and whole-word matching options
  - Priority-based keyword matching to handle overlaps
  - Custom colors for each keyword-tag pair
  - Usage statistics and tracking
  - Automatic keyword processing during message upload
  - Server-side keyword matching for consistency
  - Client-side fallback for real-time highlighting
- **AI Integration**: Keyword analysis function provides insights on usage patterns and optimization recommendations
- **Bug Fixes**:
  - Added `keywords.read` and `keywords.write` permissions to RBAC middleware
  - Implemented automatic table creation in API endpoints to ensure tables exist
  - Added table creation to control handler for message processing
  - Fixed API client method calls from `api.request()` to proper `api.get()`, `api.post()`, etc.

### v1.31.8 - Reduced Daemon Logging (August 2025)
- Implemented compile-time log level configuration in Zig build
- Created two separate Nix derivations: `sms-daemon` (info level) and `sms-daemon-debug` (debug level)
- Changed verbose modem state and signal strength logs from info to debug level
- Now only logs pending SMS operations and new messages at info level
- Significantly reduced log volume for production operations

### v3.4.0 - Lock-Free Architecture & Code Cleanup (August 2025)
- **Complete Lock-Free Implementation**: Replaced ALL mutex-based structures
  - `LockFreeMessageQueue`: Lock-free MPMC queue for message processing
  - `LockFreeSignalCache`: Atomic operations for signal caching
  - `LockFreePriorityManager`: Lock-free modem priority management
- **Performance Improvements**:
  - Eliminated all deadlocks through lock-free data structures
  - BusctlDBus wrapper reduces subprocess spawning by 90%
  - Worker pool with 8 parallel threads for modem processing
  - Adaptive timing with 50ms target cycle time
  - Priority-based polling (High/Medium/Low)
  - Bloom filter deduplication with O(1) lookups
- **Code Cleanup**:
  - Removed 12 unused source files (event_loop, mutex-based queues, etc.)
  - Streamlined imports and dependencies
  - Reduced codebase by ~40% while improving performance
- **Stability**: Daemon runs continuously with 54+ USB modems without crashes or deadlocks
- **Tested Configuration**: Orange Pi 5 Plus with 54 EC20 modems via USB hubs

### v2.0.0 - Database Architecture Refactoring (August 2025)
- **Major Schema Changes**:
  - Migrated from monolithic `phones` table to normalized structure
  - New tables: `modems`, `sims`, `modem_state`, `daemon_health`
  - Created `device_view` for backward compatibility
  - Equipment ID (IMEI) now primary key for modems
  - ICCID remains primary key for SIMs
- **Infrastructure Improvements**:
  - Centralized table creation in `/server/utils/database-setup.js`
  - Single source of truth for device counts in `/server/utils/device-count.js`
  - Standardized API responses via `/server/utils/api-response.js`
  - D1 connection wrapper with statement caching in `/server/utils/database-wrapper.js`
- **Critical Fixes**:
  - Fixed memory leak in Zig daemon's `getModemDetails()` function
  - Added transaction boundaries for multi-table updates using D1 batch API
  - Implemented stale threshold checks (60s for phantom modems, 120s for offline)
  - Equipment ID validation with synthetic ID generation fallback
- **Performance Optimizations**:
  - Batch processing with transactions (10 phones per batch)
  - Prepared statement caching for frequently used queries
  - Optimized indexes for common query patterns
- **Migration Support**:
  - Comprehensive validation scripts (`validate-migration.sql`)
  - Safe rollback procedure (`rollback-to-phones.sql`)
  - Automated validation runner (`scripts/validate-migration.js`)
- **Zig Daemon Updates**:
  - Added hardware detail collection (manufacturer, model, firmware, hardware revision)
  - Enhanced memory management with proper deallocation
  - Updated Phone struct with new hardware fields

### v3.5.0 - BusctlDBus Integration (August 2025)
- **Major Performance Improvement**: Integrated BusctlDBus wrapper into ModemManager
- All critical methods now use busctl D-Bus commands instead of mmcli when available
- Reduces subprocess spawning overhead by ~90% (busctl is much faster than mmcli)
- Methods updated: `listModems`, `getModemState`, `getIccid`, `getSignalQuality`
- Automatic fallback to mmcli if busctl fails
- Maintains backward compatibility while significantly improving performance
- Subprocess reduction: from 200+ mmcli calls/second to ~20 busctl calls/second

### v3.6.0 - Code Cleanup (August 2025)
- **Critical Fixes**:
  - Fixed hash collision bug in `LockFreeSignalCache` with linear probing (8 probe limit)
  - Removed unused mutex from `ApiClient` (was initialized but never provided benefit)
  - Removed entire unused result queue system from `WorkerPool`
- **Code Consolidation**:
  - Moved `ModemCheckResult` to `types.zig` to eliminate duplication
  - Removed unused `processModemParallel` function from worker_threads
  - Cleaned up redundant error handling patterns
- **Performance Improvements**:
  - Hash collision fix prevents silent data overwrites
  - Removed unnecessary mutex operations in API client
  - Linear probing ensures signal data integrity
- **Impact**: ~200 lines of dead code removed, 2KB memory reduction per daemon instance

### v2.1.0 - Database Normalization to 3NF (September 2025)
- **Major Schema Changes**:
  - Database normalized to strict Third Normal Form (3NF) compliance
  - Removed `iccid_mappings` table - replaced with user override fields in `sims` table
  - Removed redundant columns from `messages` table (`phone_id`, `sim_iccid`, `modem_id`)
  - Added foreign key constraints with proper referential integrity
- **User Override Pattern**:
  - Phone number overrides now stored directly in `sims` table
  - New columns: `user_phone_number`, `user_carrier`, `user_country_code`, `user_notes`
  - `user_override_enabled` flag to activate overrides
  - Maintains 3NF - no transitive dependencies or redundancy
- **API Updates**:
  - ICCID mappings handler refactored to use `sims` table
  - Updates handler fixed to remove references to deprecated tables
  - AI insights handler fixed for column name mismatches
- **Performance Impact**:
  - Database size reduced by 79% (5.31MB → 1.09MB)
  - Query optimization reduced reads from 4.89k to single scan
  - Removed complex JOIN operations with deprecated tables
- **Migration Scripts**:
  - `006a_prepare_messages_fix_v2.sql` - Normalize messages table
  - `007_add_user_overrides.sql` - Add override fields to sims
  - `008_cleanup_deprecated_tables.sql` - Remove old backup tables
