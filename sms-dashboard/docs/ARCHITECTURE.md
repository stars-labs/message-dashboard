# SMS Dashboard Architecture

## Overview

SMS management system for 100+ USB modems on Orange Pi hardware. The backend runs on Cloudflare Workers with a Svelte 5 frontend served as static assets.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Svelte 5 + TailwindCSS + Vite 7 |
| Backend | Cloudflare Workers (plain JS) |
| Database | Cloudflare D1 (SQLite) |
| Sessions | Cloudflare KV |
| Auth | Auth0 (JWT) + API key for daemon |
| Daemon | Rust + Tokio (direct AT commands) |
| Deploy | NixOS flake on Orange Pi (aarch64) |

## Architecture

```
Orange Pi (Rust Daemon)        Cloudflare Workers         Browser
┌─────────────────────┐    ┌──────────────────────┐    ┌──────────────┐
│ USB Modems (AT cmds) │    │ SimpleRouter (JS)     │    │ Svelte 5 SPA │
│ Local SQLite queue   │───>│ D1 Database (SQLite)  │<───│ TailwindCSS  │
│ Batch upload         │    │ KV Sessions           │    │ Auth0 login  │
│ Signal monitoring    │    │ Auth0 JWT + RBAC      │    │              │
└─────────────────────┘    └──────────────────────┘    └──────────────┘
     API key auth              Bearer token auth
```

## Server Structure

The server uses a custom `SimpleRouter` class (not a framework). No Hono, no Express, no itty-router.

```
sms-dashboard/
├── server/
│   ├── index.js              # SimpleRouter + route definitions
│   ├── frontend-handler.js   # Serves built Svelte assets
│   ├── handlers/             # 10 route handler modules
│   │   ├── auth0.js          # Auth0 login/logout/callback
│   │   ├── control.js        # Daemon sync (phones, messages, heartbeat)
│   │   ├── health.js         # /api/health, /api/daemon/status
│   │   ├── iccid-mappings.js # ICCID-to-phone-number mappings
│   │   ├── keywords.js       # Keyword tag management
│   │   ├── messages.js       # Message CRUD + send
│   │   ├── phones.js         # Phone list + details
│   │   ├── stats.js          # Dashboard statistics
│   │   ├── updates.js        # Polling endpoint for UI refresh
│   │   └── user-overrides.js # User phone number/carrier overrides
│   ├── middleware/
│   │   ├── auth0.js          # JWT verification
│   │   ├── cors.js           # CORS headers
│   │   └── rbac.js           # Role-based access (currently disabled)
│   ├── utils/
│   │   ├── device-count.js   # Device statistics queries
│   │   └── verification.js   # Verification code extraction
│   └── api/
│       └── keywords.js       # Keyword route setup
├── client/                   # Svelte 5 frontend
│   ├── App.svelte            # Main app with tab navigation
│   ├── main.js               # Entry point
│   └── lib/                  # Components
├── migrations/               # D1 SQL migrations (~25 files)
├── config/                   # Auth0 role config, env defaults
├── wrangler.toml             # Cloudflare Workers config
└── vite.config.js            # Vite build config
```

## Database Schema (D1)

Core tables:
- `modems` — hardware devices (PK: `equipment_id` / IMEI)
- `sims` — SIM cards (PK: `iccid`), FK to modems via `current_modem_id`
- `modem_state` — volatile signal/connection data, FK to modems
- `messages` — SMS content, FK to sims via `phone_iccid`
- `daemon_health` — heartbeat monitoring

Key view:
- `device_view` — joins modems + sims + modem_state with user overrides. **Always use this for reading device data.**

Supporting tables:
- `iccid_mappings` — phone number CSV imports
- `keyword_tags` / `message_tags` — message tagging
- `modem_sim_history` — SIM swap history
- `schema_version` — migration tracking

## Request Flow

1. Request hits Cloudflare Worker
2. `SimpleRouter.handle()` matches route
3. Middleware chain: CORS → Auth0 JWT → RBAC (order matters)
4. Handler executes D1 queries via `env.DB.prepare()`
5. JSON response returned

Daemon requests use `X-API-Key` header instead of JWT.

## Authentication

- **Users**: Auth0 OAuth2 → JWT in `Authorization: Bearer` header
- **Daemon**: Static API key in `X-API-Key` header (set via `wrangler secret put API_KEY`)
- **RBAC**: Infrastructure exists but disabled (`USE_AUTH0_ROLES = "false"`)

## Sync Flow (Daemon → Server)

1. Daemon reads modems via AT commands every 30s
2. `POST /api/control/phones` — upserts modem + SIM + state data
3. `POST /api/control/messages` — uploads new SMS (batches of 10-100)
4. `POST /api/control/heartbeat` — daemon health pulse
5. `GET /api/control/pending-sms` — picks up outgoing SMS to send
6. `POST /api/control/sms-result` — reports send success/failure

## Build & Deploy

```bash
cd sms-dashboard
bun install
bun run dev          # Frontend dev server :5173
bun run dev:api      # Wrangler local API :8787
bun run build        # Production build
bun run deploy       # Build + deploy to Cloudflare
```

Frontend is built by Vite, then `scripts/build-unified.js` inlines the assets into `server/frontend-assets.js` so the Worker serves everything from a single bundle.
