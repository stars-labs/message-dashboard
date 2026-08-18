# Orange Pi Daemon — Agent Guide

> Rust/Tokio hardware daemon for 100+ USB modems. Reads SMS and phone status via
> direct AT commands, syncs to the Cloudflare Worker API.

## Key contracts

- Authenticates with `API_KEY`, never Auth0.
- Syncs through `/api/control/devices`. The pre-v8 `/api/control/phones` route is
  removed — do not reintroduce it.
- Never writes `sims` inventory — only writes `modems` and `daemon_health`.
- `modems.detected_iccid` is the live field. `modems.current_iccid` is dead legacy —
  never read or write it.
- Daemon health and SIM state are separate domains — do not infer one from the other.

## Build and verify

```bash
check-daemon          # rustfmt check + all tests — required before every deploy

cd orange-pi-daemon
cargo build --release
RUST_LOG=debug cargo run
```

`check-daemon` is the only accepted verification gate. Do not substitute `cargo check`.

## Deploy

See [docs/deployment.md](../docs/deployment.md).

## Hardware

See [docs/usb-topology-explained.md](../docs/usb-topology-explained.md).
The binding constraint is 127 USB addresses per bus, not socket count.
