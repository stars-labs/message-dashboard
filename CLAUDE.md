# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

This is a distributed SMS management system with three main components:

1. **Web Dashboard** (`sms-dashboard/`) - Real-time SMS management interface
   - Frontend: Svelte + TailwindCSS with Vite build system
   - Backend: Cloudflare Workers with custom routing
   - Database: Cloudflare D1 (SQLite)
   - Real-time: WebSocket + SSE fallback with Durable Objects
   - Auth: Auth0 integration with RBAC

2. **SMS Collection Daemon** (`orange-pi-daemon/`) - Zig daemon for hardware integration
   - Interfaces with ModemManager via mmcli commands
   - Extracts ICCID, phone numbers, signal strength, operator info
   - Uploads data to dashboard API with API key authentication
   - Designed for Orange Pi 5 Plus with multiple USB modems

3. **NixOS Configuration** (`nixos-config/`) - Declarative system deployment
   - Flake-based NixOS configuration for Orange Pi
   - SMS daemon service definition and modem support
   - Secrets management with SOPS

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
npx wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM phones"
```

### SMS Daemon (Zig)
```bash
cd orange-pi-daemon
zig build-exe src/main.zig        # Compile daemon
export SMS_API_URL="https://sexy.qzz.io"
export SMS_API_KEY="your-api-key"
./main                             # Run daemon
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

### Data Flow
```
Orange Pi → mmcli → Zig Daemon → API (API Key) → D1 Database → WebSocket Broadcast → Frontend
                                      ↓
                              User Auth (Auth0) → Protected API → Frontend
```

### Database Schema Critical Points
- `phones.id` is ICCID (SIM card identifier) - never null
- `messages.phone_id` references `phones.id` (ICCID)
- Control handler rejects phones without valid ICCIDs

## Common Issues & Debugging

### Frontend Crashes
- Null ID handling: Always check `phone.id && phone.id.length` before calling `.slice()`
- Search filters: Verify `.toLowerCase()` availability before calling

### Backend Data Issues
```bash
# Clean up invalid phone entries
npx wrangler d1 execute sms-dashboard --command "DELETE FROM phones WHERE id IS NULL OR (id LIKE 'phone-%' AND iccid IS NULL)" --remote

# Monitor API calls causing issues
npx wrangler tail sms-dashboard --format pretty
```

### SMS Daemon Issues
- Check ModemManager status: `systemctl status ModemManager`
- Verify modem detection: `mmcli -L`
- Check ICCID extraction: `mmcli -m [modem_id]` then `mmcli -i [sim_id]`
- HTTP Communication: As of v1.1.1, daemon uses curl subprocess for reliable HTTP requests
  - Zig's native HTTP client had issues with response handling
  - All API calls now use curl with proper error handling
  - Requires curl in system PATH (added to NixOS config)

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
# Check phone count and status
npx wrangler d1 execute sms-dashboard --command "SELECT status, COUNT(*) FROM phones GROUP BY status" --remote

# Recent messages
npx wrangler d1 execute sms-dashboard --command "SELECT * FROM messages ORDER BY created_at DESC LIMIT 10" --remote
```

## Critical System Dependencies

### Orange Pi Hardware Requirements
- ModemManager for modem interface
- USB hub with adequate power for multiple EC20 modems
- ICCID extraction depends on mmcli SIM path parsing

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

## Recent Changes (July 2025)

### v1.1.1 - HTTP Client Migration
- Replaced Zig's native HTTP client with curl subprocess calls
- Fixed "Failed to write payload: error.NotWriteable" errors
- Improved reliability of message uploads and phone status updates
- Added comprehensive logging for HTTP request/response debugging

### Architecture Update
- Daemon now uses HTTP POST requests to upload data (not WebSocket)
- Server broadcasts updates via WebSocket/SSE to connected clients
- API endpoints: `/api/control/phones` and `/api/control/messages` 
