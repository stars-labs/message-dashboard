# SMS Dashboard

A distributed SMS management system for 100+ USB modems running on Orange Pi hardware, with a web dashboard hosted on Cloudflare.

## Architecture

![System architecture](docs/architecture/message-dashboard.svg)

**Daemon** (Rust, Tokio) reads SMS from USB modems with direct AT commands.
ModemManager over D-Bus is opt-in with `USE_DBUS=1`. It buffers messages in local
SQLite, uploads them to the Worker, syncs device status and heartbeats, and polls
for outbound SMS to send. An optional voice bridge carries call audio between the
modems and Cloudflare Realtime.

**API** runs on Cloudflare Workers with a D1 (SQLite) database and KV sessions.
It stores messages and device state, classifies spam, extracts verification
codes, tags keywords, correlates balance replies, and runs cron maintenance.

**Frontend** is a Svelte 5 SPA served from the same Worker. It shows devices,
messages, balances, carrier bills, and keyword and filter configuration.

**Balance Agent** is an Electron app and CLI that runs on an operator's Mac. It
claims balance jobs from the Worker, uses an AI model to read carrier SMS
replies, and drives carrier web portals with Playwright.

### Data flow

![Data flow](docs/architecture/message-dashboard-dataflow.svg)

D1 is the single source of truth and doubles as the work queue. Outbound SMS,
balance checks, and runner jobs are status rows that the daemon and the Agent
poll through the Worker. See [docs/architecture](docs/architecture/README.md)
for each flow step by step.

## Where to start

- [AGENTS.md](AGENTS.md): components, hard boundaries, git hooks and the reference
  docs; each component has its own guide linked from there.
- [docs/deployment.md](docs/deployment.md): deploying the Worker, the Orange Pi
  and the Balance Agent.
- [docs/usb-topology-explained.md](docs/usb-topology-explained.md): what limits how
  many modems the Pi can run.

## Key Design Decisions

- **AT commands over ModemManager**: 1-5ms vs 50-500ms per operation, essential for 100+ modems
- **Request/refresh over persistent streaming**: Eliminates WebSocket/SSE connection costs on Cloudflare
- **D1 over external DB**: SQLite bound to the Worker, no separate database service. D1 is also the work queue (status rows, polled), so its read quota is the main scaling limit
- **NixOS over traditional Linux**: Declarative, reproducible Orange Pi configuration
- **Local SQLite queue**: the daemon keeps every received message locally until the Worker acknowledges it, so network interruptions lose nothing
