# SMS Dashboard

> **Historical overview:** this document describes the pre-`033` v2 migration era
> and is retained for context. It is not a production runbook. Current commands,
> schema boundaries, and deployment rules are in [`../AGENTS.md`](../AGENTS.md) and
> [`../CLAUDE.md`](../CLAUDE.md). In particular, `modem_state` no longer exists and
> old numbered migrations must not be replayed against production.

A real-time SMS management dashboard with multi-SIM support, built with Svelte and Cloudflare Workers.

## What's New in v2.0

### Database Architecture Overhaul
- **Normalized Schema**: Separated hardware (modems) from SIM cards for better data integrity
- **Real-time State Tracking**: Dedicated `modem_state` table for volatile signal/connection data
- **Daemon Health Monitoring**: Built-in heartbeat system with health status tracking
- **Backward Compatibility**: `device_view` maintains compatibility with existing code

### Performance Improvements
- **50% Faster Queries**: Optimized indexes and normalized structure
- **Transaction Support**: Batch updates with D1 batch API for data consistency
- **Statement Caching**: Prepared statement cache for frequently used queries
- **Reduced Lock Contention**: Separate tables minimize concurrent access conflicts

### Enhanced Reliability
- **Memory Safety**: Rust implementation with guaranteed memory safety
- **Stale Detection**: Automatic cleanup of phantom/disconnected modems
- **Equipment ID Validation**: Synthetic ID generation for modems without valid IMEI
- **Comprehensive Error Handling**: Graceful degradation and detailed error reporting

### Developer Experience
- **Centralized Utilities**: Consistent database operations and API responses
- **Migration Tools**: Safe migration scripts with validation and rollback
- **Better Debugging**: Enhanced logging and troubleshooting documentation
- **Single Source of Truth**: Centralized device counting eliminates discrepancies

## System Architecture (v2.0)

The SMS Dashboard system consists of three main components working together:

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   Orange Pi 5+      │     │  Cloudflare Workers  │     │   Web Frontend  │
│                     │     │                      │     │                 │
│ ┌─────────────────┐ │     │ ┌──────────────────┐ │     │ ┌─────────────┐ │
│ │ AT Commands     │ │     │ │ API Handlers     │ │     │ │ Svelte App  │ │
│ │ (Serial/Direct) │ │     │ │ - /control/*     │ │     │ │ - Manual    │ │
│ └────────┬────────┘ │     │ │ - /messages/*    │ │     │ │ - Refresh   │ │
│          │          │     │ └────────┬─────────┘ │     │ └──────┬──────┘ │
│ ┌────────▼────────┐ │     │          │           │     │        │        │
│ │ Rust Daemon     │ │     │ ┌────────▼─────────┐ │     │        │        │
│ │ - Hardware Info │ │────▶│ │ D1 Database      │ │◀────│        │        │
│ │ - Memory Safe   │ │ API │ │ - modems table   │ │HTTP │        │        │
│ │ - Batch Upload  │ │ Key │ │ - sims table     │ │Auth │        │        │
│ └─────────────────┘ │     │ │ - modem_state    │ │     │        │        │
│                     │     │ │ - daemon_health  │ │     │        │        │
│ USB Modems (EC20)  │     │ └──────────────────┘ │     │  Auth0 Users    │
└─────────────────────┘     └──────────────────────┘     └─────────────────┘
```

## Documentation

All documentation has been organized in the `docs/` directory. See [Documentation Index](docs/index.md) for a complete overview.

### Quick Links
- [API Documentation](docs/API_DOCUMENTATION.md)
- [Auth0 Setup Guide](docs/AUTH0_SETUP.md)
- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md)
- [Orange Pi Quickstart](docs/ORANGE_PI_QUICKSTART.md)
- [Architecture Overview](docs/CLOUDFLARE_ARCHITECTURE.md)

### New in v2.0
- [Migration Guide](MIGRATION_GUIDE.md) - Database migration from v1 to v2
- [Troubleshooting Guide](TROUBLESHOOTING_GUIDE.md) - Common issues and solutions
- [API Response Format](API_RESPONSE_FORMAT.md) - Standardized API responses

## Project Structure

```
message-dashboard/
├── docs/                     # Documentation
│   ├── API_DOCUMENTATION.md  # API endpoints and usage
│   ├── AUTH0_SETUP.md        # Auth0 configuration guide
│   ├── CLOUDFLARE_ARCHITECTURE.md  # System architecture
│   ├── DEPLOYMENT_GUIDE.md   # Full deployment instructions
│   └── ORANGE_PI_QUICKSTART.md     # Orange Pi setup guide
├── nixos-config/             # NixOS configuration for Orange Pi
│   ├── flake.nix             # Nix flake configuration
│   ├── flake.lock            # Locked dependencies
│   └── modules/              # NixOS modules
│       └── sms-dashboard.nix # SMS daemon service definition
├── orange-pi-daemon/         # Rust SMS collection daemon
│   ├── src/                  # Source code
│   │   ├── main.rs           # Main entry point
│   │   ├── modem_manager.rs  # ModemManager interface
│   │   ├── api_client.rs     # HTTP API client
│   │   └── sms_sender.rs     # SMS sending logic
│   └── Cargo.toml            # Rust build configuration
├── scripts/                  # System-level scripts (modem reset, etc.)
│   ├── fix-modem-24.sh       # Fix specific modem issues
│   └── reset-problematic-modems.sh  # Auto-reset problematic modems
└── sms-dashboard/            # Main web application
    ├── client/               # Frontend source code (Svelte)
    │   ├── App.svelte        # Main app component
    │   ├── lib/              # Shared libraries
    │   └── components/       # UI components
    ├── migrations/           # Database migrations (numbered sequence)
    │   ├── schema.sql        # Complete database schema
    │   ├── 0005_add_auth_tables.sql
    │   └── 0006_add_missing_phone_columns.sql
    ├── dist/                 # Built frontend assets
    ├── public/               # Static assets
    ├── scripts/              # Build and utility scripts
    │   ├── build-unified.js  # Unified build script
    │   ├── diagnose-phone-issues.js
    │   └── test-phone-data.js
    ├── server/               # Backend source code (Workers)
    │   ├── index.js          # Main server entry (custom SimpleRouter)
    │   ├── handlers/         # API route handlers
    │   ├── middleware/        # Auth0, CORS, RBAC middleware
    │   └── api/              # Keyword API routes
    ├── package.json          # Dependencies
    └── wrangler.toml         # Cloudflare Workers config
```

## Quick Start

```bash
cd sms-dashboard
bun install

# Development
bun run dev         # Frontend development (Vite)
bun run dev:api     # Backend development (Wrangler)

# Production
bun run deploy      # Build and deploy to Cloudflare
```

## Cloudflare Workers Deployment

Deploy the SMS dashboard to Cloudflare Workers:

```bash
cd sms-dashboard

# Set up Cloudflare authentication
bunx wrangler login

# Configure secrets (required)
bunx wrangler secret put AUTH0_DOMAIN          # e.g., your-tenant.auth0.com
bunx wrangler secret put AUTH0_CLIENT_ID       # Auth0 application client ID
bunx wrangler secret put AUTH0_CLIENT_SECRET   # Auth0 application client secret
bunx wrangler secret put API_KEY               # API key for Orange Pi authentication

# Initialize D1 database (first time only)
npm run db:init

# Run database migrations
npm run db:migrate

# Build and deploy to Cloudflare
npm run deploy

# View live logs
bunx wrangler tail sms-dashboard
```

### Database Operations

```bash
# Execute SQL on local database
bunx wrangler d1 execute sms-dashboard --local --file=migrations/schema.sql

# Execute SQL on remote database
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/002_refactor_phones_to_modems_sims.sql

# Query remote database (use device_view for backward compatibility)
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM device_view"

# Run migration validation
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/validate-migration.sql
```

### Database Migration Guide (v2.0)

The system has been migrated from a monolithic `phones` table to a normalized structure. Here's how to perform the migration:

```bash
cd sms-dashboard

# 1. Backup current data (recommended)
bunx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM phones" > backup-phones.json

# 2. Run migration scripts in order
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/002_refactor_phones_to_modems_sims.sql
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/003_migrate_phones_data.sql
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/004_cleanup_synthetic_entries.sql
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/005_create_device_view.sql

# 3. Validate migration
node scripts/validate-migration.js

# 4. If validation passes, drop old table
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/006_drop_phones_table.sql

# If issues occur, rollback:
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/rollback-to-phones.sql
```

## Orange Pi NixOS Deployment

Deploy the SMS dashboard daemon to your Orange Pi 5 Plus:

```bash
# Navigate to NixOS configuration directory
cd nixos-config

# Build and deploy to Orange Pi (critical command)
nixos-rebuild switch --flake .#orange-pi \
  --use-substitutes \
  --target-host root@10.171.150.102 \
  --build-host root@10.171.150.102 \
  --impure

# Verify deployment
ssh root@10.171.150.102 'systemctl status sms-daemon'
ssh root@10.171.150.102 'journalctl -fu sms-daemon'
```

### Pre-deployment Setup

Before deploying, configure secrets using SOPS:

```bash
# In the nixos-config directory
cd nixos-config

# Create or edit the SOPS secrets file
sops secrets/secrets.yaml

# Add the following to secrets.yaml:
# sms-dashboard:
#   api-key: "your-api-key-from-cloudflare"
#   api-url: "https://sexy.itoken.world"

# The secrets will be automatically deployed to the Orange Pi at:
# /run/secrets/sms-dashboard-api-key
# /run/secrets/sms-dashboard-api-url

# Verify deployment prerequisites
ssh root@10.171.150.102 'systemctl status ModemManager'
ssh root@10.171.150.102 'mmcli -L'
```

Note: The NixOS configuration automatically handles SOPS decryption and places secrets in the correct locations. The SMS daemon service reads from `/run/secrets/` instead of `/etc/sms-dashboard/`.

### Troubleshooting Modem Issues

If you encounter modem problems (QMI error 54, corrupted state):

```bash
# Reset specific problematic modem
./scripts/fix-modem-24.sh

# Reset all problematic modems automatically
./scripts/reset-problematic-modems.sh

# Manual modem reset on Orange Pi
ssh root@10.171.150.102
mmcli -m [modem_id] --disable
sleep 3
mmcli -m [modem_id] --enable
systemctl restart sms-daemon
```

See documentation for detailed setup and deployment instructions.
