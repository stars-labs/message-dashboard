# System Architecture

Multi-node SMS platform: an Orange Pi Rust daemon drives 100+ EC20 USB modems,
a Cloudflare Worker owns all state in D1, operators use a Svelte SPA, and a
local Balance Agent runs AI and browser balance jobs.

Schema rules and auth contracts live in [data-contracts.md](../data-contracts.md);
this page describes how the parts connect.

## System overview

![System architecture](message-dashboard.svg)

| Component | Runtime | Talks to | Auth |
|---|---|---|---|
| Rust daemon (`orange-pi-daemon/`) | Tokio on Orange Pi, NixOS | EC20 modems over AT commands on `/dev/ttyUSB*`; Worker `/api/control/*` | `X-API-Key` |
| Worker API (`sms-dashboard/server/`) | Cloudflare Worker, `sexy.itoken.world` | D1 `DB`, KV `SESSIONS`, Auth0, Realtime SFU | — |
| Dashboard SPA (`sms-dashboard/client/`) | Svelte 5, served by the same Worker | Worker `/api/*` | Auth0 login, HttpOnly cookie, RBAC |
| Balance Agent (`sms-dashboard/balance-agent/`) | Electron app + CLI on an operator Mac, built on `runner-core/` | Worker `/api/control/*`, company AI API, carrier web portals | Auth0 device flow, scoped to the requesting `sub` |
| Realtime SFU | Cloudflare Realtime | Browser WebRTC media; daemon voice bridge over `wss` | per-call HMAC |

Notes:

- The daemon uses AT commands by default. ModemManager over D-Bus is opt-in
  with `USE_DBUS=1`.
- Only the Worker reads or writes D1. The daemon and the Agent connect outbound
  and poll; neither accepts inbound requests, except the daemon's voice bridge
  listener, which runs only when `VOICE_BRIDGE_DOMAIN` is set.
- The Worker has no Durable Objects or streaming transport. Clients use
  request/refresh flows.

## Data flow

![Data flow](message-dashboard-dataflow.svg)

Every arrow that touches D1 passes through a Worker handler. The diagram leaves
that hop out of the Agent arrows to keep them short.

### Inbound SMS

1. The daemon reads modem storage with `AT+CMGL` and buffers rows in its local
   SQLite store, so uploads survive network and D1 outages.
2. It uploads with `POST /api/control/messages`. In the same request, the
   Worker classifies spam and links balance replies to their pending check.
3. Keyword tagging and carrier-bill parsing run in `ctx.waitUntil`. The nightly
   cron reconciles anything they missed.

### Outbound SMS and balance queries

1. The SPA queues a send or a balance check. The Worker writes the check row
   and a queued outbound row in `messages`.
2. The daemon polls `/api/control/pending-sms` every 10 s, sends with
   `AT+CMGS`, and reports `/api/control/sms-result`.
3. The carrier's reply arrives as inbound SMS and is linked to the check. A
   skill job is then queued for the Balance Agent, which asks the AI to read
   the reply and posts the decision back.

### Web balance (browser)

The Agent claims a carrier web-balance job and drives a persistent Playwright
profile. When the carrier sends a login OTP, that SMS arrives through the
inbound path, and the Agent reads it from the job's `/otp` endpoint. CAPTCHA
and slider checks are handed off to the operator.

### Device state

The daemon syncs `/api/control/devices` every 30 s and sends a heartbeat every
60 s. These update `modems` and `daemon_health`. All reads go through
`device_view`.

### Scheduled work

| Cron | Work |
|---|---|
| `*/5 * * * *` | Expire balance checks and web balance jobs past their response window |
| `17 4 * * *` | Also: 12-month message retention, spam backfill, carrier-bill reconcile |

## Regenerating the diagrams

The SVGs are exported from [Archify](https://github.com/tt-a1i/archify)
diagrams. The source candidates live under `.archify/` and are not committed.
Each diagram cites the source lines it was drawn from, at commit `15ec680`.
