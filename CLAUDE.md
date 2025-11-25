# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## System Overview

This is a distributed SMS management system handling 100+ USB modems on Orange Pi hardware. It consists of:
- **Rust daemon** (`orange-pi-daemon/`) that interfaces with ModemManager to collect SMS
- **Cloudflare Workers API** (`sms-dashboard/server/`) with D1 database
- **Svelte frontend** (`sms-dashboard/client/`) with real-time WebSocket updates
- **NixOS deployment** (`nixos-config/`) for declarative system configuration

## Common Development Tasks

### Building and Running the Rust Daemon
```bash
cd orange-pi-daemon
cargo build --release                    # Production build (optimized)
cargo test                               # Run all tests
cargo test test_signal_cache_basic      # Run specific test
RUST_LOG=debug cargo run                # Run with debug logging

# Required environment variables:
export SMS_API_URL="https://sexy.qzz.io"
export SMS_API_KEY="your-api-key"
```

### Frontend Development
```bash
cd sms-dashboard
bun install                              # Install dependencies (using bun)
bun run dev                              # Vite dev server (localhost:5173)
bun run dev:api                          # Wrangler API dev server
bun run build:unified                    # Build production bundle
bun run deploy                           # Deploy to Cloudflare
```

### Database Operations
```bash
cd sms-dashboard
# Local development
npx wrangler d1 execute sms-dashboard --local --file=migrations/schema.sql

# Remote operations (production)
npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"
npx wrangler tail sms-dashboard --format pretty    # Live production logs

# Run migrations
npx wrangler d1 migrations apply sms-dashboard --remote
```

### NixOS Deployment
```bash
# Build daemon package
nix build .#sms-daemon

# Deploy to Orange Pi (203.116.95.146)
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@203.116.95.146 --build-host root@203.116.95.146 \
    --impure

# Check service status
ssh root@203.116.95.146 'systemctl status sms-daemon'
ssh root@203.116.95.146 'journalctl -u sms-daemon -f'
```

## Architecture & Data Flow

### Request Flow
```
Orange Pi Hardware → ModemManager → Rust Daemon → Cloudflare API → D1 Database
                                         ↓                              ↓
                                    (API Key Auth)              (WebSocket Broadcast)
                                                                         ↓
                                                                   Svelte Frontend
                                                                         ↑
                                                                   (Auth0 Auth)
```

### Key Components

**Rust Daemon (`orange-pi-daemon/src/`)**
- `main.rs`: Event loop with 30-second sync intervals
- `modem_manager.rs`: ModemManager interface using D-Bus exclusively (no subprocess for SMS/modem operations)
- `native_dbus.rs`: Native D-Bus implementation using zbus for direct communication (5ms per operation)
- `dbus_client.rs`: D-Bus client with automatic fallback (native zbus → busctl CLI only)
- `sms_sender.rs`: SMS sending via native D-Bus (no mmcli subprocess)
- `sync_manager.rs`: Full/incremental sync state management (5-min full sync)
- `retry_manager.rs`: Exponential backoff (3 retries: 1s, 2s, 4s)
- `worker_pool.rs`: Concurrent modem processing (2 workers for 92+ modems)
- `api_client.rs`: HTTP client with `/api/control/devices` endpoint

**Cloudflare Workers API (`sms-dashboard/server/`)**
- `index.js`: Custom router with middleware chain (CORS → Auth → RBAC → Handler)
- `api/control.js`: Device upload endpoints (dual auth: API key for daemon, Auth0 for users)
- `websocket.js`: Durable Objects for real-time broadcasting
- `utils/database-setup.js`: Table creation and migration logic
- `utils/database-wrapper.js`: D1 wrapper with prepared statement caching

**Frontend (`sms-dashboard/client/`)**
- `App.svelte`: Main component with WebSocket/SSE connection
- `lib/api.js`: API client with Auth0 token handling
- `lib/websocket-with-fallback.js`: Real-time updates with automatic reconnection
- `lib/stores.js`: Svelte stores for state management

### Database Schema (Normalized 3NF)

```sql
modems (equipment_id PRIMARY KEY)    -- Hardware devices (IMEI)
sims (iccid PRIMARY KEY)             -- SIM cards with user overrides
modem_state (modem_id FOREIGN KEY)   -- Real-time status (signal, connection)
messages (phone_iccid FOREIGN KEY)   -- SMS messages linked to SIMs
daemon_health                         -- Heartbeat monitoring
device_view                          -- Compatibility view joining all tables
```

User overrides in `sims` table:
- `user_phone_number`, `user_carrier`, `user_country_code`, `user_notes`
- `user_override_enabled` flag to activate overrides

## Critical Configuration

### Environment Variables
```bash
# Rust Daemon
SMS_API_URL="https://sexy.qzz.io"
SMS_API_KEY="<from wrangler secrets>"
RUST_LOG="info"  # or "debug" for troubleshooting

# Cloudflare Workers (set via wrangler secret put)
AUTH0_DOMAIN
AUTH0_CLIENT_ID
AUTH0_CLIENT_SECRET
API_KEY  # Must match SMS_API_KEY
```

### API Endpoints
- `/api/control/devices` - Daemon uploads (POST, API key auth)
  - Accepts `sync_mode`: "full" or "incremental"
  - Normalized payloads: separate `modems` and `sims` arrays
- `/api/control/messages` - SMS upload (POST, API key auth)
- `/api/phones` - Frontend device list (GET, Auth0 auth)
- `/api/messages` - Frontend message list (GET, Auth0 auth)

### Performance Constraints & Optimizations
- **Native D-Bus**: Zero subprocess overhead using zbus library
  - Native D-Bus: ~5ms per operation (primary method)
  - Busctl fallback: ~50ms per operation (when native unavailable)
  - No mmcli: Removed entirely - was ~500ms per operation
- Daemon handles 92+ modems with 2-worker pool
- 30-second sync interval to avoid Cloudflare rate limits
- Full sync every 5 minutes for state reconciliation
- Signal caching: 30-second TTL reduces redundant D-Bus calls
- D1 batch operations limited to 10 phones per transaction
- WebSocket broadcasts throttled to prevent overload

## Troubleshooting

### Common Issues
1. **Wrangler auth errors**: Run `npx wrangler login`
2. **Daemon 503 errors**: Check sync interval (must be ≥30s)
3. **Missing modems**: Verify ModemManager service is running
4. **Database inconsistencies**: Check `device_stats` view for counts

### Debug Commands
```bash
# Check modem hardware
mmcli -L                                 # List modems
mmcli -m 0                              # Modem details
lsusb | grep -i modem                   # USB devices

# Database validation
npx wrangler d1 execute sms-dashboard --remote --file=migrations/validate-migration.sql
node scripts/validate-migration.js

# Service logs
journalctl -u ModemManager -f           # ModemManager logs
journalctl -u sms-daemon -f             # Daemon logs
npx wrangler tail sms-dashboard         # API logs
```

## Project-Specific Patterns

1. **Always use device_view** for backward compatibility when reading device data
2. **Sync modes**: Use "full" for recovery, "incremental" for normal operation
3. **Timestamp format**: ISO 8601 with timezone (e.g., "2025-10-05T19:05:42+08:00")
4. **Error handling**: Daemon uses retry manager with exponential backoff
5. **Auth pattern**: Dual auth system - API keys for daemon, Auth0 for users
6. **State management**: Signal cache holds 256 entries with hash-based lookup
7. **USB ordering**: Use `modem_state.usb_port` for consistent device ordering