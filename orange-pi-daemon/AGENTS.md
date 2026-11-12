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
- `types::PendingSms` and `PendingSmsResponse` define the shared pending-SMS
  payload. A missing `purpose` retains the established `user` default.
- Outbound polling in `SmsSender` sends its daemon session ID. Preserve its
  per-poll HTTP client, 10-second timeout, and HTTP error response details.
- SMS send methods return `Result<SmsSubmission>`: `Ok` means confirmed or
  submitted without confirmation; a failed submission must be `Err`.

## Build and verify

```bash
check-daemon          # rustfmt check + strict Clippy + all tests — required before every deploy

cd orange-pi-daemon
cargo build --release
RUST_LOG=debug cargo run
```

`check-daemon` is the only accepted verification gate. Do not substitute `cargo check`.
Clippy checks all targets and features, including tests and diagnostic binaries,
and treats every warning as an error. Fix violations rather than suppressing them;
any unavoidable exception must be narrowly scoped and explain the external constraint.

## Deploy

See [docs/deployment.md](../docs/deployment.md).

## Hardware

See [docs/usb-topology-explained.md](../docs/usb-topology-explained.md).
The binding constraint is 127 USB addresses per bus, not socket count.
