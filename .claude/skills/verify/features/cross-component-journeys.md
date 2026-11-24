# Cross-component journeys

Flows that cross the Worker's boundary with the daemon or the Balance Agent. Those two
cannot be rolled back with the Worker, so a change on either side of `/api/control/*`
is proven here end to end, not only by the recorded fixtures. Per-surface handles live
in the linked files; read them first. Run last in a sweep.

## Sub-features

- send → deliver: a dashboard send offered to the daemon, its outcome reported, the
  row's badge updated ([dashboard-send](dashboard-send.md),
  [daemon-send-outbox](daemon-send-outbox.md)).
- balance query over SMS AI: dashboard query → daemon send → carrier menu upload →
  skill job → Balance Agent decision → follow-up SMS
  ([agent-sms-ai-run](agent-sms-ai-run.md)).
- inventory → availability: a modem reported connected or gone changes which SIMs can
  send and be queried ([daemon-device-sync](daemon-device-sync.md)).

## How to get to it (user POV)

These are the operator's real days: send a code request, query a balance, swap a SIM.

## Driving it with bun run verify

```bash
bun run verify -- --journey scripts/verify/journeys/daemon-contract.ts --out <dir>
bun run verify -- --journey scripts/verify/journeys/sms-ai-reply.ts --out <dir>
```

Both are checked in, typechecked and linted with the scripts. A change to the control
protocol, `shared/control-fixtures/`, the balance flow or the daemon's wire types runs
both, in addition to `check-daemon` and `bun run test`.

## Gotchas

- These journeys stand in for the daemon; they prove the Worker and the dashboard
  against the recorded wire, not the daemon binary. The daemon's half is
  `orange-pi-daemon/tests/control_fixtures_tests.rs` under `check-daemon`.
- Each run starts from the seed; a journey brings its own preconditions through
  production paths (device sync, the SIM dialog), never through `d1()` writes.
- Carrier-browser jobs stop at `pending`; see
  [agent-carrier-browser](agent-carrier-browser.md).
