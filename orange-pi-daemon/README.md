# Orange Pi SMS Daemon

Rust daemon for managing 100+ USB modems on Orange Pi hardware. Reads SMS via direct AT commands, buffers locally in SQLite, and uploads to Cloudflare Workers API.

**Version**: 8.0.0 | **Runtime**: Tokio (4 threads, ARM-optimized) | **Target**: aarch64-linux (NixOS)

## Architecture

```
USB Modems (ttyUSB*)
       |
       v
  AT Commands (1-5ms per op)          Fallback: D-Bus/ModemManager (50ms)
       |
       v
  Worker Pool (16 concurrent, 24/batch, 12s timeout)
       |
       v
  SQLite Queue (WAL mode, dedup, 7-day retention)
       |
       v
  Cloudflare Workers API (dynamic batching 10-100, exponential backoff)
```

### Concurrent Tasks

The daemon runs independent async loops so one stalled responsibility does not
block the others:

| Task | Interval | Purpose |
|------|----------|---------|
| Modem Reader | 1s | Read SMS from all modems in parallel, store to SQLite, delete from SIM |
| Database Uploader | dynamic | Upload pending messages in batches (10-100), backoff on failure |
| Device Status Sync | 30s | Sync modem/SIM state to API (full every 5min, incremental otherwise) |
| Statistics Logger | 60s | Log message queue stats, warn if SIM has >200 messages |
| Auto-Cleanup | 5min | Remove old pending messages (ModemManager deletion bug workaround) |
| Multipart Cleanup | 5min | Remove incomplete multipart segments after their assembly window |
| SMS Sender | 10s | Poll API for outbound SMS, route to correct modem via ICCID |
| Health Heartbeat | 30s | Report process, task, queue, and modem health independently |
| Modem Re-discovery | 60s | Add newly enumerated or recovered modem ports to the live set |

### Source Layout

```
src/
  main.rs            Entry point, task spawning, systemd integration
  modem_manager.rs   Coordinator: AT (default) or D-Bus backend (USE_DBUS=1)
  at_modem.rs        Direct serial AT commands for Quectel EC20 modems
  dbus_client.rs     D-Bus abstraction: native zbus -> busctl CLI fallback
  native_dbus.rs     Zero-overhead D-Bus via zbus v4 (100x faster than mmcli)
  api_client.rs      HTTP client for Cloudflare Workers API
  message_store.rs   Local SQLite queue with deduplication and lifecycle tracking
  sync_manager.rs    Full/incremental sync state machine
  worker_pool.rs     Semaphore-based parallel modem processing
  signal_cache.rs    30s TTL signal strength cache (reduces redundant queries)
  retry_manager.rs   Exponential backoff (1s -> 2s -> 4s -> ... -> 30s cap)
  sms_sender.rs      Outbound SMS: poll API, route by ICCID, report results
  types.rs           Data structures (Config, Modem, Sim, Message)
  lib.rs             Module exports + 24 unit tests
  benchmark.rs       AT vs D-Bus vs mmcli performance comparison
```

## Building

```bash
# Local development
cd orange-pi-daemon
cargo build --release

# NixOS
nix build .#sms-daemon

# Run tests (24 tests)
cargo test
```

Release profile: `opt-level=3`, LTO, single codegen unit, stripped symbols.

## Running

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SMS_API_URL` | `https://sexy.qzz.io` | Backend API endpoint |
| `SMS_API_KEY` | (required) | API authentication key |
| `MESSAGE_DB_PATH` | `/var/lib/sms-daemon/messages.db` | Local SQLite queue path |
| `USE_DBUS` | `0` | Set `1` to use ModemManager D-Bus instead of AT commands |
| `RUST_LOG` | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error` |

### Systemd

```bash
sudo systemctl enable --now sms-daemon
journalctl -fu sms-daemon                # Follow logs
```

### Manual

```bash
SMS_API_KEY="your-key" cargo run --release
```

### CLI Commands

```bash
orange-pi-daemon              # Run daemon (default)
orange-pi-daemon benchmark    # AT vs D-Bus performance comparison
orange-pi-daemon cleanup      # Clean old messages from SQLite
```

## Modem Hardware

Each Quectel EC20 modem exposes 4 USB serial ports:

| Port | Function | Used by daemon |
|------|----------|----------------|
| ttyUSB0 | DM/diagnostic | No |
| ttyUSB1 | GPS/NMEA | No |
| ttyUSB2 | AT commands | Yes |
| ttyUSB3 | PPP data | No |

The daemon uses `ttyUSB2` for all AT operations via `nix::termios` (no libudev dependency).

## Performance

| Metric | Value |
|--------|-------|
| AT command latency | ~1-5ms per operation |
| D-Bus latency | ~50ms per operation |
| mmcli latency | ~500ms per operation |
| 92+ modems full scan | <0.5 seconds (AT) vs 46 seconds (mmcli) |
| Memory | ~30MB typical |
| CPU | ~20% on 4-core ARM |

## Key Design Decisions

- **AT over D-Bus**: Direct serial AT commands bypass ModemManager overhead. D-Bus is fallback only.
- **Local SQLite queue**: Messages survive network outages. WAL mode for concurrent read/write. Deduplication via `(phone_iccid, timestamp, content)` unique constraint.
- **Dynamic batching**: Upload batch size scales 10-100 based on payload size. Shrinks on failures, grows when healthy.
- **Immediate SIM deletion**: Messages are deleted from SIM right after reading to prevent ModemManager's deletion bug from causing duplicates.
- **Signal caching**: 30-second TTL cache avoids redundant modem queries during polling cycles.
- **Independent health reporting**: Business requests do not define process health.
  The heartbeat includes per-task success ages and failures, local queue depth, real
  build version, and modem counts so one healthy loop cannot hide another stalled loop.

## Troubleshooting

```bash
# Check modem hardware
lsusb | grep -i quectel
mmcli -L

# Check ModemManager
systemctl status ModemManager

# Debug logging
RUST_LOG=debug journalctl -fu sms-daemon

# Test API connectivity
curl -H "x-api-key: KEY" https://sexy.qzz.io/api/control/pending-sms

# Check local message queue
sqlite3 /var/lib/sms-daemon/messages.db "SELECT status, COUNT(*) FROM messages GROUP BY status"
```
