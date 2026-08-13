# Daemon Health Monitoring Plan

## Status

Implemented in the working tree on 2026-08-11. Deployment must follow the compatibility
order below: Worker/frontend first, daemon second, legacy cleanup only after observation.

## Problem

The dashboard currently treats a recent request from the Orange Pi daemon as
proof that the daemon is healthy. In practice, the outbound SMS polling task can
continue updating `daemon_health.last_heartbeat` while modem scanning, message
uploading, or device synchronization is stalled.

The UI also mixes three separate concerns:

1. Whether the daemon process can reach Cloudflare.
2. Whether the daemon's core processing tasks are healthy.
3. Whether individual modems and SIM cards are healthy.

The `93 / 95` device count already answers the third question. The daemon status
indicator should answer the first two without implying that every SIM is healthy.

## Goals

- Distinguish process liveness from pipeline health and device health.
- Detect a stalled daemon task even when another task is still contacting the API.
- Return structured reasons for degraded states.
- Use server-received timestamps so Orange Pi clock drift cannot corrupt status.
- Preserve local message buffering during network outages.
- Deploy without falsely marking the existing daemon offline.

## Status Model

| Status | Meaning |
| --- | --- |
| `healthy` | Heartbeat is current and all core tasks are progressing. |
| `degraded` | Daemon is alive, but one or more core tasks are stale or repeatedly failing. |
| `offline` | The backend has missed enough independent heartbeats to consider the daemon unavailable. |
| `unknown` | No valid health report has been received yet. |

Suggested user-facing labels:

- `采集服务正常 · 刚刚`
- `采集服务部分异常 · 设备同步`
- `采集服务离线 · 6分钟前`
- `采集服务检测中`

The device inventory count remains separate, for example `93 / 95 张卡在线`.

## Daemon Health Snapshot

Add a shared `HealthSnapshot` to the Rust daemon. Each task updates its own
section after an attempt and after a successful cycle.

The snapshot should include:

- Session ID and process uptime.
- Actual build version.
- Last successful modem scan age.
- Last successful device synchronization age.
- Last successful outbound SMS poll age.
- Last message upload attempt and success ages.
- Consecutive failure count and last error for each task.
- Local SQLite pending upload count.
- Discovered, responsive, and SIM-readable modem counts.

Use Rust monotonic time to calculate task ages. Do not depend on the Orange Pi
wall clock for freshness decisions.

Example payload:

```json
{
  "schema_version": 1,
  "session_id": "rust-daemon-...",
  "version": "8.0.0",
  "uptime_seconds": 86400,
  "tasks": {
    "modem_reader": {
      "last_success_age_seconds": 2,
      "consecutive_failures": 0,
      "last_error": null
    },
    "device_sync": {
      "last_success_age_seconds": 14,
      "consecutive_failures": 0,
      "last_error": null
    },
    "outbound_poll": {
      "last_success_age_seconds": 3,
      "consecutive_failures": 0,
      "last_error": null
    },
    "message_uploader": {
      "last_attempt_age_seconds": 8,
      "last_success_age_seconds": 8,
      "consecutive_failures": 0,
      "last_error": null
    }
  },
  "queue": {
    "pending_uploads": 0
  },
  "modems": {
    "discovered": 93,
    "responsive": 93,
    "sim_readable": 93
  }
}
```

## Independent Heartbeat

Add a dedicated daemon task that posts the health snapshot to
`POST /api/control/heartbeat` every 30 seconds.

The Worker must record `last_heartbeat` using its own `CURRENT_TIMESTAMP`. The
payload's task ages are useful telemetry, but the daemon-supplied wall clock must
not decide whether the service is online.

After the new heartbeat is deployed and verified:

- `/api/control/pending-sms` must stop updating daemon liveness.
- `/api/control/devices` may update device synchronization telemetry, but must not
  independently mark the whole daemon healthy.
- The five-minute `Heartbeat - daemon is healthy` log in `main.rs` remains only a
  local log and must not be confused with the cloud heartbeat.
- The unused KV heartbeat path should be removed or consolidated into D1 so that
  there is one source of truth.

## Backend Health Derivation

Create a pure function such as `deriveDaemonHealth(snapshot, now)` and use it as
the only status decision point.

Initial thresholds:

| Signal | Degraded | Offline or critical |
| --- | --- | --- |
| Independent heartbeat | Older than 90 seconds | Older than 180 seconds |
| Modem reader | No success for 120 seconds | No success for 300 seconds |
| Device synchronization | No success for 90 seconds | No success for 300 seconds |
| Outbound SMS poll | No success for 45 seconds | No success for 180 seconds |
| Message uploader | Three failures while queue is non-empty | Sustained failure with growing backlog |

An idle uploader is not unhealthy when the pending queue is empty.

The API response should be structured:

```json
{
  "status": "degraded",
  "label": "部分异常",
  "reasons": ["设备状态同步已中断 3 分钟"],
  "last_seen_at": "2026-08-11 10:48:24",
  "version": "8.0.0",
  "session_id": "rust-daemon-...",
  "tasks": {},
  "queue": {},
  "modems": {}
}
```

The current `warning` state must not render as `检测中`. Either migrate it to
`degraded` or explicitly map it to a warning presentation during compatibility.

## Frontend

Replace the current daemon pill semantics with a collection-service indicator.

The compact indicator shows status, the primary reason, and relative heartbeat
time. Clicking it opens a small operational detail panel containing:

- Daemon heartbeat.
- Modem scanning status.
- Device synchronization status.
- Outbound polling status.
- Upload queue and uploader status.
- Actual daemon version.
- Session ID.
- Manual refresh control.

Use green for healthy, amber for degraded, red for offline/error, and neutral for
unknown. Device and SIM faults continue to use the existing device status UI and
must not automatically mark the whole daemon offline.

## Tests

### Rust

- Each task updates its health section on attempt, success, and failure.
- Consecutive failures reset after success.
- Snapshot serialization is stable and versioned.
- Task age calculation uses monotonic time.
- An empty upload queue does not make the uploader stale.

### Worker

- Boundary tests for heartbeat and every task threshold.
- Combined-state tests where the process is alive but one task is stale.
- Server receipt time, not daemon wall time, controls liveness.
- Payload validation and schema-version compatibility tests.
- Legacy daemon requests remain compatible during rollout.

### Frontend

- Healthy, degraded, offline, and unknown rendering.
- Degraded reasons appear in the compact indicator and detail panel.
- D1, ISO, epoch, missing, and invalid timestamps render safely.
- Device count and daemon health remain visually and semantically separate.

### End To End

- Stopping the full daemon shows offline within three minutes.
- Stalling only modem scanning shows degraded, not healthy or offline.
- Stalling only device synchronization reports the correct reason.
- A Cloudflare outage leaves new messages buffered in local SQLite.
- A single SIM or modem failure changes device status without marking the daemon
  offline.

## Deployment Plan

1. Deploy Worker support for both legacy and versioned health reports.
2. Deploy frontend support for both old and new API response shapes.
3. Deploy the daemon health snapshot and independent heartbeat task.
4. Observe production task timestamps for at least ten minutes.
5. Verify health transitions by safely simulating one task failure at a time.
6. Remove legacy heartbeat side effects from pending-SMS and device-sync routes.
7. Remove or consolidate the separate KV heartbeat implementation.
8. Update `CLAUDE.md` and `orange-pi-daemon/README.md` with the final contract and
   operational troubleshooting steps.

## Rollback

- Keep the Worker compatible with the old daemon throughout rollout.
- If the daemon deployment fails, restore the previous service derivation without
  changing device data.
- Do not remove legacy heartbeat writes until the versioned heartbeat has remained
  stable in production.
- Schema additions must be nullable so an older daemon can continue operating.

## Acceptance Criteria

- The UI never reports the whole service as healthy solely because pending-SMS
  polling succeeds.
- A stalled core task produces a specific degraded reason.
- A missed heartbeat produces offline status within three minutes.
- The displayed version is the daemon's real build version, not a route default.
- `warning` is never presented as `检测中`.
- Invalid timestamps never render `NaN`.
- The device online count remains independent from collection-service health.
