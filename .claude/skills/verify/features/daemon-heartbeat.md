# Daemon: heartbeat and health

Every 60s the Orange Pi daemon posts `/api/control/heartbeat`: version, uptime, how long
since it last read and uploaded SMS, and its upload queue. The dashboard turns it into
the 采集服务 status and the health panel.

## Sub-features

- heartbeat body: `schema_version` 3, `session_id`, `version`, `uptime_seconds`,
  `last_message_read_success_age_seconds`, `last_upload_success_age_seconds`,
  `queue { pending, in_flight, dead_letter, oldest_unacknowledged_age_seconds }`.
- status: 采集服务正常 / 部分异常 / 离线 / 错误 in the header and MoreMenu.
- panel `采集服务状态`: 短信读取, 消息上传, 最老积压, 待处理, 上传中, 人工处理, 版本;
  "N 条消息需要人工处理" when `dead_letter` > 0.
- refusals: a non-JSON body, an unsupported schema version, a wrong key
  (`shared/control-fixtures/daemon/heartbeat.*.json`).
- alert emails (`server/utils/alerts.ts`, five-minute cron): no heartbeat for 20
  minutes, and the check itself failing; state in the `alert_state` table. Offline
  SIMs deliberately send no email.

## How to get to it (user POV)

Header button 采集服务… (desktop) or 更多 → 运行状态 (mobile). The daemon side has no UI;
it is `orange-pi-daemon/src/health.rs` and `periodic_tasks.rs`.

## Driving it with bun run verify

```ts
await daemon('/api/control/heartbeat', { body: {
  schema_version: 3, session_id: 'e2e-session', version: '8.0.2', uptime_seconds: 7200,
  last_message_read_success_age_seconds: 3, last_upload_success_age_seconds: 4,
  queue: { pending: 1, in_flight: 0, dead_letter: 2, oldest_unacknowledged_age_seconds: 90 },
} }); // 200
await p.getByRole('button', { name: /采集服务/ }).nth(0).click();
const panel = p.getByRole('dialog', { name: '采集服务状态' });
await panel.getByText('2 条消息需要人工处理').waitFor(); // header: 采集服务部分异常
await panel.getByText('8.0.2').waitFor();
```

Checked in: `scripts/verify/journeys/daemon-contract.ts`.

Alerts: fire the cron at a chosen time instead of waiting, and read `alert_state`.
The stack runs `wrangler dev --test-scheduled` with `ALERT_RECIPIENTS` set to a fake
address; `notified_at` is written only after `EMAIL.send()` resolved.

```ts
const at = Date.now() + 25 * 60_000; // the seeded heartbeat looks 25 minutes old
const r = await fetch(`${stack.baseUrl}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('*/5 * * * *')}&time=${at}&format=json`);
// body {"outcome":"ok",…}; then: daemon_offline notified
await stack.d1('SELECT alert, first_seen_at, notified_at FROM alert_state');
```

## Gotchas

- The daemon's own half (building the body, the stall watchdog) is proven by
  `check-daemon` and `orange-pi-daemon/src/wire/tests.rs`, not here:
  the daemon cannot run on a Mac (it reads `/sys/class/tty`).
- The seeded heartbeat is stamped at stack start; a long journey sees it age.
- The scheduled trigger is `/cdn-cgi/local/scheduled`, not the older `/__scheduled`:
  that path falls through to the app shell and answers 200 without running anything,
  so check for `"outcome":"ok"`. The local cron also fires on its own every five
  minutes, so a journey can find an `alert_state` row it did not cause.
- A wire change here must change the fixture, the Worker and the daemon together
  (`shared/control-fixtures/`), and `check-api-compat` fails on it.
