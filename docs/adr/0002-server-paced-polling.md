# ADR 0002: The Worker paces every recurring call, and proves each one's D1 reads are bounded

- Status: accepted (GRA-258)
- Date: 2026-11-26

## Context

A poll, heartbeat or cron job runs thousands of times a day, so a few hundred
rows read per run add up to millions. Over the 7 days before 2026-11-26,
`failUnsendableMessages` ran 17,679 times inside the daemon's `pending-sms` poll
and read 7,005,296 rows, 63% of all D1 reads in that week, reading every sent
message each time with the queue empty. No test noticed. The rule in
`sms-dashboard/AGENTS.md` ("Recurring D1 read budget") asks for an estimate and
a bounded-read test, but nothing checks that either exists.

Checking needs to know which calls recur and how often. Today the intervals
live in four places, two of them deployed separately from the Worker:

| Caller | Call | Interval | Where it is set |
|---|---|---|---|
| Balance Agent, per runner | `carrier-web-balance/jobs/claim`, `balance-skills/jobs/claim` | 5 s when idle | `retryDelay: 5_000` literals in `balance-agent/src/runner/capabilities/` |
| Balance Agent, per runner | `balance-runners/heartbeat` | 30 s | `presence.ts` |
| Pi daemon | `pending-sms` | 10 s | `periodic_tasks.rs` |
| Pi daemon | `devices` | 30 s | `periodic_tasks.rs` |
| Pi daemon | `heartbeat` | 60 s | `periodic_tasks.rs` |
| Dashboard, per open tab | page refresh, batch progress, calls | 60 s, 10 s, 3–10 s | `client/` constants |
| Worker cron | maintenance, alerts, retention | 5 min, daily | `wrangler.toml` |

A list kept beside these constants would drift from them unnoticed. A list
checked against them would need a JSON mirror for the Rust daemon and a test in
every component.

Established protocols put the pace in the server's answer instead: OAuth device
authorization (RFC 8628) returns `interval` and answers `slow_down` to a client
that polls too fast; GitHub's Events API sends `X-Poll-Interval`. The Balance
Agent already follows the first one in `auth0-device.ts`.

## Decision

### 1. One registry of recurring calls, owned by the Worker

`shared/recurring.ts` lists every recurring call: the contract route or cron
trigger, its interval, and the most callers it serves (one daemon, a stated
number of runners, a stated number of open dashboards). It is the only place an
interval is written down.

- The Worker reads it to pace clients (2) and to limit them (3).
- The dashboard imports its intervals from it. The dashboard ships inside the
  Worker, so the two cannot disagree.
- `wrangler.toml`'s cron schedule is checked against the registry by a test,
  since wrangler cannot import it.

### 2. Clients deployed apart from the Worker poll when the Worker says

Every response on a recurring `/api/control/*` route carries
`X-Poll-Interval: <seconds>`, read from the registry. A header, not a body
field, because the idle claim answers `204 No Content`, which has no body.

- The daemon and the Balance Agent wait that long before the next call. They
  hold no interval constant of their own beyond one default for a response
  without the header: a network error, a 5xx, or a Worker from before this
  change during the rollout.
- They clamp the value to 1–600 seconds, so one bad answer cannot stop a loop or
  turn it into a busy loop.
- The Worker can lengthen an interval without a client release: a longer idle
  claim interval when no job is queued, or every interval when D1 nears its
  quota.

### 3. The Worker refuses a caller that polls faster than paced

A caller that ignores the header, through a bug or an old release, gets
`429 Too Many Requests` with `Retry-After`, from the Cloudflare Workers Rate
Limiting binding keyed by caller (`runner_id`, the daemon's key). The limit is
the registry's rate with headroom (twice it). A refused call reads no D1 rows,
so the read budget holds whatever a client does.

### 4. Every registry entry has a bounded-read test, and the registry has a budget

- `server/recurring-calls.test.ts` makes every idle call (the daemon's and the
  Agent's as their fixtures record them, the dashboard's as the client sends them,
  each cron run) on a Miniflare D1, which counts rows as production D1 bills them,
  with a production-sized fleet: once without history and once with 2000 rows each
  of sent messages and finished jobs. A call that reads more the second time fails.
  It measures reads rather than judging query plans: a plan cannot tell a partial
  index over the pending queue, which is bounded, from one over all sent history,
  which is how `failUnsendableMessages` read 7 million rows.
- Each registry entry maps to its idle call in a `Record` keyed by the registry,
  so a new entry without one is a type error; an entry that runs only while work
  is in progress maps to none.
- A budget test sums, over the idle entries, callers × calls a day × rows read per
  call, and fails above the daily budget.

### Budgets are set against the free plan

The free plan covers this system's normal traffic; the paid plan since
2026-11-26 is an exception, not the limit to design for. The free plan allows
5,000,000 rows read and 100,000 rows written a day, across the account.

- Idle recurring reads: at most 1,000,000 a day, a fifth of the allowance, so
  the dashboard and real work keep the rest. Checked by the budget test.
- Recurring writes (heartbeats, device sync, runner presence): at most 20,000 a
  day, a fifth of the allowance; about 6,000 a day today. A unit test on SQLite
  cannot count index writes, so this is checked from Query Insights after a
  deploy (`bun run d1:hot-queries`, extended to rank by rows written), and in
  advance by `bun run db:rehearse` for one-off SQL.
- The dashboard counts as 5 open tabs.

### 5. Push stays out of scope

Replacing the two busiest polls with a pushed notification (a Durable Object
holding a hibernated WebSocket, as `CALL_STATE` does for calls) removes idle
reads altogether, but needs a long-lived connection in both the daemon and the
Agent. It gets its own card once (1)–(4) show what idle polling still costs.

## Rollout

`/api/control/*` cannot be rolled back with the Worker: the daemon and the Agent
deploy on their own (`sms-dashboard/AGENTS.md`, Verification). The header is
added before anything relies on it:

1. Worker: the registry, the header on every recurring control response, the
   fixtures recording it (the fixture format gains `response.headers`), the
   bounded-read helper, census and budget tests. Clients ignore the new header.
2. Balance Agent release: every loop waits for the header; the `retryDelay`
   literals go.
3. Daemon deploy: the three Worker-facing loops wait for the header; their
   `Duration` literals go.
4. Worker: the rate limit, once Query Insights shows both clients pacing by the
   header (`bun run d1:hot-queries`, and runs a day per statement matching the
   registry).

Each step is one deploy that the previous one does not depend on reversing.

## Alternatives considered

- **A registry that clients import, with a JSON mirror for the daemon.**
  Single-sourced for TypeScript, but the Rust constants stay and need a
  cross-language test to stay equal, and changing a pace still needs a release
  of every client.
- **A `recurring` field on the contract's `route()`.** Cron is not on the
  contract, so the declaration splits in two, and client intervals stay
  hand-kept.
- **A hand-written list, unchecked.** Drifts from the clients unnoticed, which
  is how the rule in `AGENTS.md` failed.

## Consequences

- An interval changes in one file and reaches every client on the next Worker
  deploy. Pacing becomes a Worker decision that can react to load and quota.
- A new recurring call cannot land without a registry entry and a bounded-read
  test, and the registry's total stays inside the budget.
- The control protocol gains a header in both directions of the rollout, and
  the fixtures, the daemon and the Agent are tested against it.
- The budget is only as true as the registry's caller counts; the dashboard's is
  the number of open tabs, which the Worker cannot see.
- A query plan is SQLite's on the test database, not D1's on production data.
  They can differ: before 084, `claimSkillJob` read 114 rows a run in production
  while its local plan searched an index. The post-deploy check in Query Insights
  stays required; the tests catch a missing index, not every planner choice.
- What stays outside these checks: calls that do not recur (a page load, a
  report), and how many rows an active queue holds. A bounded read is bounded by
  the work waiting, so a backlog still costs reads in proportion to it.
- The budget counts D1 only. Every signed-in dashboard request also reads the
  session from KV, whose free plan allows 100,000 reads a day: the registry's idle
  dashboard polls make 13,248 requests a day per tab, 66,240 at five tabs.
- When step 1 landed, the idle calls read about 946,000 of the 1,000,000 rows:
  device sync reads every modem every 30 seconds (296,640), the two Agent claims
  read 207,360 each, and the dashboard's runner status 144,000. The next recurring
  call needs one of these cut first.
