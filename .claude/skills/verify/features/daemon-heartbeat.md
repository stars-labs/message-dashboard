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

## Gotchas

- The daemon's own half (building the body, the stall watchdog) is proven by
  `check-daemon` and `orange-pi-daemon/src/wire/tests.rs`, not here:
  the daemon cannot run on a Mac (it reads `/sys/class/tty`).
- The seeded heartbeat is stamped at stack start; a long journey sees it age.
- A wire change here must change the fixture, the Worker and the daemon together
  (`shared/control-fixtures/`), and `check-api-compat` fails on it.
