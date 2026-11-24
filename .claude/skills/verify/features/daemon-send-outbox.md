# Daemon: send outbox

Every 10s the daemon polls `/api/control/pending-sms` for queued SMS (user sends and
balance queries), sends each over its modem, and reports the outcome to
`/api/control/sms-result`.

## Sub-features

- poll: `GET /api/control/pending-sms` with header `x-daemon-session-id`; each offered
  message moves `sending` → `processing`.
- result: `{ message_id, outcome: 'confirmed' | 'submitted_unconfirmed' | 'failed',
  error_message }` → `sent` / `unknown` / `failed` (with `error_message`).
- UI: the feed row's badge 等待发送 → 发送中 → 已发送 / 结果未知 / 发送失败.
- balance queries ride the same queue (`purpose: 'balance_maintenance'`).

## How to get to it (user POV)

Send from 发送短信 ([dashboard-send](dashboard-send.md)), then watch the row in 消息.

## Driving it with bun run verify

```ts
// after a send of 'daemon contract' from the drawer:
const pending = (await daemon('/api/control/pending-sms', { sessionId: 'e2e-session' })).body;
// pending.pending_messages[] holds { id, content: 'daemon contract', recipient, … }
// D1 status now 'processing'
await daemon('/api/control/sms-result', { body: {
  message_id: id, outcome: 'failed', error_message: 'CMS ERROR: 500' } });
await p.reload();
await p.locator('[data-message-row]').filter({ hasText: 'daemon contract' })
  .getByText('发送失败').waitFor(); // D1: status 'failed', error_message kept
```

Checked in: `scripts/verify/journeys/daemon-contract.ts`.

## Gotchas

- Nothing is sent: the journey stands in for the daemon and decides the outcome.
  Real delivery is the daemon's AT path, proven on the Pi only.
- A poll takes everything pending; find yours by content.
- `sms-result` without `message_id` is a 400.
