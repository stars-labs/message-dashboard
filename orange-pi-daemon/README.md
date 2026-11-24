# Orange Pi SMS Daemon

Rust daemon for managing 100+ USB modems on Orange Pi hardware. Reads SMS via direct AT commands, buffers locally in SQLite, and uploads to Cloudflare Workers API.

- Build, test and the contracts a change must keep: [AGENTS.md](AGENTS.md)
- Deploying to the Pi: [docs/deployment.md](../docs/deployment.md)
- Environment variables and subcommands: `orange-pi-daemon-rust --help` (it does not
  list the `VOICE_BRIDGE_*` variables, which `nixos-config/modules/sms-daemon.nix` sets)
- Rules for reading and deleting SMS on the modem: [docs/sms-storage-safety.md](../docs/sms-storage-safety.md)
- USB limits and modem identity: [docs/usb-topology-explained.md](../docs/usb-topology-explained.md)

## Key Design Decisions

- **AT over D-Bus**: Direct serial AT commands bypass ModemManager overhead. D-Bus is opt-in (`USE_DBUS=1`).
- **Local SQLite queue**: Messages survive network outages. WAL mode for concurrent read/write. Deduplication via `(phone_iccid, timestamp, content)` unique constraint.
- **Prompt hardware deletion**: a message is deleted from the modem or SIM as soon as it is stored locally, because a full SIM makes the carrier drop new SMS.
- **Signal caching**: a TTL cache avoids redundant modem queries during polling cycles.
- **Independent health reporting**: Business requests do not define process health.
  The heartbeat includes per-task success ages and failures, local queue depth, real
  build version, and modem counts so one healthy loop cannot hide another stalled loop.
