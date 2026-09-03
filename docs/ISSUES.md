# ISSUES

Incident log — one entry per real issue faced in production. Each entry: what
happened, root cause, what broke, the fix (or planned fix), and how to verify
it doesn't recur. Append new entries to the bottom. Number them sequentially.

---

## #1 — D1 free-tier daily row-read quota exhausted

**Date:** 2026-09-02 (Singapore, UTC+8).

**Symptom.** Any D1 read query failed with:
```
Your account has exceeded D1's free tier daily row read limit.
Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.
```
This broke the phone-number → ICCID lookup used to fetch SMS by MSISDN: the
only place the `sims` mapping (ICCID ↔ phone_number ↔ carrier) lives is D1's
`sims` table. The Orange Pi's local SQLite (`/var/lib/sms-daemon/messages.db`)
stores SMS traffic but **no** SIM-inventory mapping, so with D1 unavailable
there was no local fallback. SMS receipt and local storage were unaffected —
messages kept arriving and saving to the Pi — but resolving a phone number to
its ICCID became impossible without asking the operator.

**Root cause.** Cloudflare D1 free tier caps daily row reads per account. The
limit is account-wide, so any read-heavy query (dashboard traffic, ad-hoc
wrangler queries, the daemon's own sync reads) consumes the same budget. Once
exhausted, **all** reads fail until 00:00 UTC, regardless of which route
caused it. Writes have a separate quota; the dashboard showed that quota was
also exceeded (124.58k / 100k), although the error blocking this request was
specifically the row-read quota.

**Cloudflare Query Insights evidence.** A read-only Query Insights capture on
2026-09-03 at approximately 10:22 Singapore time grouped the rolling three-hour
window by normalized SQL and sorted it by total rows read. The returned query
groups totaled 1,786,969 rows read, matching the dashboard's rounded 1.78M
observation. The five dominant old-version operations were:

| Operation | Runs | Average rows read | Total rows read | Share |
|---|---:|---:|---:|---:|
| Dashboard incremental message poll | 83 | 15,573 | 1,292,589 | 72.3% |
| Daemon pending-outbound selection | 915 | 179 | 163,835 | 9.2% |
| Daemon stale `processing` recovery | 813 | 176 | 143,752 | 8.0% |
| Full-sync disconnected-modem reconciliation | 32 | 4,470 | 143,040 | 8.0% |
| Modem upsert conflict checks | 25,563 | 1 | 25,563 | 1.4% |

The first four query shapes accounted for 97.5% of the observed reads. The
largest query was the old dashboard's 15-second incremental message poll:

```sql
SELECT ...
FROM messages m
LEFT JOIN device_view dv ON m.phone_iccid = dv.iccid
WHERE m.purpose = 'user'
  AND m.created_at >= datetime(?, '-2 seconds')
  AND m.filter_status IN (?, ?)
ORDER BY m.created_at DESC, m.id DESC
LIMIT ? OFFSET ?
```

It returned few or no new messages but scanned an average of 15,573 rows per
execution. At one request every 15 seconds, the observed 83 executions require
only about 20 minutes 45 seconds to consume 1.29M row reads; additional open
dashboard tabs multiply that cost. The daemon's three scan-heavy query shapes
plus its upsert checks contributed another 476,190 rows. `UPDATE` statements
appear here because D1 counts rows scanned while locating update candidates as
rows read even when zero rows are changed.

The evidence was captured with:

```bash
bunx wrangler d1 insights sms-dashboard \
  --time-period 3h \
  --sort-type sum \
  --sort-by reads \
  --sort-direction DESC \
  --limit 100
```

Query Insights uses a rolling window while the billing UI uses a
calendar-bounded usage view, so the SQL attribution and proportions are the
durable evidence; the rounded totals should not be treated as an exact
timestamp-boundary reconciliation.

**Post-deployment verification.** The Orange Pi switched to daemon v8.0.1 at
2026-09-03 10:31:55 Singapore time. At the 10:59 check the service was still
active with zero restarts. It discovered all 94 modems, completed the initial
full sync at 10:32:52, and every subsequent 30-second incremental sync
completed successfully. The Pi log recorded 94 reports in the one-time full
sync and only 14 changed-modem reports from then through 10:58; no incremental
cycle resent all 94 modems.

The one-hour Query Insights window still contained old-version samples, so its
whole-window averages were not valid post-deployment rates. Two consecutive
snapshots at approximately 10:58 and 10:59 isolated the new executions:

| Operation | Before deployment | Post-deployment evidence |
|---|---:|---:|
| Dashboard incremental message poll | 15,572 rows/read | 17 runs, 25 rows total; Insights reported 1 row/read average |
| Pending-outbound poll | 179 rows/read | 8 new runs, 24 new rows; 3 rows/read |
| Stale `processing` recovery | 176 rows/read | 7 new runs, 14 new rows; 2 rows/read |
| Modem status upload | all 94 every cycle | one 94-row startup sync, then only changed rows |

The fixed dashboard query therefore reduced the dominant per-poll cost by
more than 99.99%. The old `LEFT JOIN device_view` query group remained at
exactly three runs and 46,716 rows across both snapshots, showing that it was
rolling-window residue rather than a query still being issued during the
measurement interval. The new bounded query shape was stable at 17 runs and
25 total rows read.

Writes showed the same intended shape. The new modem-upsert query group had
115 executions, 115 rows read, and 460 D1-counted rows written. Ninety-four of
those executions were the one-time startup full sync; D1 counted four writes
per modem upsert because table and index maintenance are included. The daemon
heartbeat remains one upsert per minute (one row read and one row written),
and the two observed inbound SMS inserts cost 13 D1-counted writes each because
the message row updates several indexes. The old `sync_history` insert visible
once in the rolling window was pre-deployment residue; migration 073 removed
that table and the deployed path no longer writes it. Migration 074 itself
cost 64,545 reads and 31,710 writes while building indexes, but that was a
one-time deployment cost and must not be projected as steady-state traffic.

**Post-deployment query frequencies.** A daily estimate must multiply each
statement's row cost by its actual trigger frequency. The deployed timers and
event triggers are:

| D1 operation | Trigger frequency | Maximum normal executions/day | Measured cost | Daily contribution |
|---|---:|---:|---:|---:|
| Recover stale outbound `processing` rows | Every 10 seconds, one daemon | 8,640 | 2 reads/run | 17,280 reads |
| Select pending outbound messages | Same 10-second request | 8,640 | 3 reads/run | 25,920 reads |
| Daemon health upsert | Immediately at start, then every 60 seconds | About 1,440 | 1 read + 1 write/run | About 1,440 reads + 1,440 writes |
| Modem delta upsert | Local comparison every 30 seconds; D1 only when a modem changed | At most 2,880 checks, but zero D1 statements for an empty delta | 1 read + 4 writes/changed modem | Traffic-dependent; 14 changed reports in the first 26 minutes |
| Full modem upsert | Once after daemon start; again only after 3 consecutive sync failures | Normally once/process | 94 modem statements at current hardware count | One-time 94 reads + 376 writes |
| Dashboard incremental messages | Every 60 seconds per visible Dashboard tab | 1,440/tab | 25 reads / 17 runs = 1.47 reads/run | About 2,118 reads/day/tab |
| Dashboard daemon status | Every 5 minutes per visible Dashboard or Balance tab | 288/tab | 1 read/run | About 288 reads/day/tab |
| Balance runner status display | On Balance view mount, then every 30 seconds while mounted | 2,880/tab | Two queries totaling about 9 reads/poll | About 25,920 reads/day/tab if left open continuously |
| Initial phones + messages + enrichment | Login, reload, pull-to-refresh, or relevant scope change | User-driven; no timer | About 639 reads/full load in this capture | `639 * full loads` |
| Inbound message duplicate check and insert | Only when the Pi uploads a new or explicitly requeued SMS | Traffic-driven; no timer | New insert: 1 read + 13 writes/message | At 100 SMS/day: about 100 reads + 1,300 writes |

Hidden browser tabs do not execute the Dashboard polling body. The 60-second
message timer runs only on the Dashboard view; the Balance view has its own
30-second runner-status timer. No-message modem cycles compare state locally
and make no device-sync request to D1. The daemon checks its local SQLite
upload queue every 100 ms, but that is not a D1 query; it calls D1 only when a
message is pending, in batches of up to 50 messages.

The Balance Agent was not actively contributing writes during this capture,
so it is excluded from the measured steady-state projection below. When it is
online, each enabled capability attempts an idle job claim every 5 seconds
(up to 17,280 claims/day/capability). Its presence object also has a 30-second
heartbeat, and the current claim loop calls `presence.set('ready')` before each
claim, which sends another heartbeat even when the state did not change. That
is up to approximately 20,160 presence requests/day/capability before real job
state transitions. This is a separate, unmeasured write-amplification risk; the
current projection must not be used for a continuously running Balance Agent.

Using the measured empty-queue costs and the configured polling intervals, the
early steady-state projection with the Balance Agent inactive is approximately
60k-100k rows read per day and 6k-10k rows written per day under current
traffic. The largest fixed daemon
read component is now the 10-second outbound poll: `(3 + 2) * 8,640 = 43,200`
rows/day while the queue is empty. A dashboard tab left open continuously adds
about 2,118 message-poll rows/day at the observed `25 / 17` rows per poll;
normal page loads and the observed modem deltas account for the remainder. This
is roughly 1-2% of the 5M daily read
allowance and 6-10% of the 100k daily write allowance, rather than the previous
quota-exhausting rate. This is an early projection from about 27 minutes of
post-deployment operation, not a completed 24-hour measurement. The first
clean billing-day validation window begins at 2026-09-04 08:00 Singapore time
(00:00 UTC); the Cloudflare daily counter before then still includes the old
queries and one-time index creation.

The public health endpoint was still `degraded` at 10:57, but D1 was connected
and the daemon heartbeat was fresh. Its reasons were the incident's existing
recovery backlog (96 attempt-exhausted messages and 3 stale `uploading` rows),
not a new sync failure. The Pi's live queue reported zero pending and zero
uploading messages while new uploads continued to succeed. Backlog recovery is
a separate operator action and was not performed as part of this measurement.

**Contributing factor.** The `fetch-sms` skill's number→ICCID resolution had
two paths — D1 lookup, then a content-echo fallback (searching SMS bodies for
the subscriber's own number, which works for Chinese carriers that send
bill-reminder SMS echoing the MSISDN). The fallback does not cover non-CN
carriers (e.g. M1 Singapore), leaving no resolution path during a D1 outage.

**What broke (severity).**
- 🔴 Number → ICCID resolution — the primary operator workflow ("get SMS for
  18573562112") failed. Had to fall back to asking the operator for the ICCID
  or modem port.
- 🟡 Dashboard reads — any page hitting D1 was unavailable; the dashboard was
  effectively read-broken for the rest of the UTC day. After the monitoring
  fix, the API returned a structured quota-specific 503 instead of a generic
  500, but the frontend still reduced it to generic collection/daemon errors.
- 🟢 SMS receipt / local storage — **unaffected.** The daemon kept receiving
  and saving to local SQLite. No data loss. Cloud uploads failed and remained
  recoverable in the local queue.

**Latent risk exposed.** Each message is attempted at most five times. After
that it remains locally recoverable but is no longer retryable automatically.
At the incident check there were 82 attempt-exhausted messages and 3 stuck in
`uploading`, so recovery after the quota reset requires an explicit, bounded
requeue instead of assuming the uploader will retry everything by itself.

**Mitigations completed.** Recurring Worker reads were bounded (`244d2d8`),
the health API now distinguishes D1 quota failures from daemon failures and
the daemon reports exhausted/stuck queue state (`cbc387c`), and authentication
audits no longer make D1 part of the login critical path (`6a2d7d7`). The
production follow-up (`b6e31f0`) added the final message-list indexes, removed
`sync_history`, and changed modem status sync from full-cycle writes to delta
uploads.

**Fix (planned — see [`TODO.md`](TODO.md)).** Back up the `sims` mapping to a
local `sim_inventory` table on the Pi's `messages.db`, refreshed from D1 on a
schedule. D1 stays the single source of truth; the Pi copy is a read-only
cache that makes number→ICCID resolution work during D1 outages. Also wire the
local lookup into the `fetch-sms` skill as a path ahead of the content-echo
fallback.

**Gate.** D1 quota reset at 2026-09-03 00:00 UTC (08:00 Singapore).

**How to verify the fix works.**
1. Disable D1 reads (or wait for a quota outage).
2. Resolve a phone number to ICCID via the local `sim_inventory` table.
3. Confirm the `fetch-sms` skill returns SMS for that number without hitting
   D1 — i.e. the local path is exercised, not the fallback to D1.

**How to detect a recurrence.** The health API now returns
`D1_QUOTA_EXCEEDED`, the quota kind, `retry_at`, and `Retry-After`. The
remaining UI gap is to render that contract as a D1-specific banner and pause
D1-backed polling until the retry time; the current frontend still shows
generic collection and daemon errors.

---

## #2 — Production domain `sexy.qzz.io` stopped resolving; moved to `sexy.itoken.world`

**Date:** discovered 2026-08-25; reverted 2026-08-26 (Beijing).

**Symptom.** The production domain `sexy.qzz.io` stopped resolving — DNS
returned NXDOMAIN-style failure, so the dashboard was unreachable on it.
Operators hitting `https://sexy.qzz.io` got a browser-level "can't reach" error,
not an application error. The Worker itself was fine; only the custom-domain
attachment was broken.

**Root cause.** The `qzz.io` domain was deleted/expired on the registrar side.
The Worker's custom-domain route depended on it, so when the zone disappeared
the custom hostname stopped resolving. This was a registrar/DNS failure, not
a Cloudflare Worker failure — the Worker kept serving via its
`*.workers.dev` path, but every hardcoded reference to `sexy.qzz.io` was now a
dead pointer.

**What broke (severity).**
- 🔴 Dashboard access via the public domain — the operator-facing URL was dead.
- 🔴 **Daemon cloud sync** — the Orange Pi daemon's `apiUrl` default was
  `https://sexy.qzz.io` (`nixos-config/modules/sms-daemon.nix`). With the
  domain gone, the daemon's uploads to the Worker all failed. SMS receipt and
  local SQLite storage were unaffected, but nothing reached D1 until the
  config was repointed and the daemon restarted. (Same "local-safe, cloud-broken"
  shape as issue #1.)
- 🟡 **Auth0 role namespace** — the role claim URI
  (`https://sexy.itoken.world/roles`, in `wrangler.toml`) is bound to a domain
  in the Auth0 config; repointing the Worker domain without keeping the claim
  namespace aligned would silently break role-based access.
- 🟡 Docs and config hardcodes — `CLAUDE.md`, `wrangler.toml`, daemon module
  default, and `docs/deployment.md` all carried the old domain.

**Timeline (from git).**
- `1e846a9` (2026-08-25 16:32 +08) "new domain" — repointed the daemon's
  `apiUrl` default from `sexy.qzz.io` to `sexy.itoken.world`.
- `06a03c3` (2026-08-26 14:06 +08) "revert: move production domain back to
  sexy.itoken.world" — `sexy.qzz.io` does not resolve; point config, docs, and
  the Auth0 role namespace back at the working domain until the `qzz.io`
  custom-domain attachment is verified end to end.

**Fix.** Cut over fully to `sexy.itoken.world`: Worker custom domain, daemon
`apiUrl` default, Auth0 role namespace, and all doc/config references. The
revert commit's wording ("until the qzz.io custom-domain attachment is
verified end to end") implies the `qzz.io` route was *intended* to come back
later — but in practice the transfer to `sexy.itoken.world` became permanent.
Production today: `https://sexy.itoken.world` (per `CLAUDE.md`).

**How to verify the fix worked.**
1. `curl https://sexy.itoken.world/api/health` returns 200.
2. The daemon's `journalctl -u sms-daemon` shows upload successes
   (`status=uploaded`), not `cloud_sync_failed` with DNS errors.
3. Auth0-protected dashboard pages load with correct role-based access (no
   silent 401/403 from a mismatched role-namespace domain).

**How to detect a recurrence.** A domain going unresolvable is silent on the
Worker side — the Worker keeps serving its `workers.dev` route, so the
dashboard looks "up" from Cloudflare's view while being unreachable from the
public hostname. Two cheap mitigations:
1. A DNS-resolution health check (external monitor hitting the public hostname,
   not the `workers.dev` route) that pages on NXDOMAIN.
2. A daemon-side sync-health alarm: if `cloud_sync_failed` persists > N minutes
   with DNS-class errors, surface it — the daemon already detects sync
   failures, just doesn't escalate them.

**Lesson.** Every hardcoded production domain is a latent single point of
failure. The config had the domain in four places (daemon module default,
`wrangler.toml` ×2, `CLAUDE.md`, `docs/deployment.md`); a cutover missed in
any one leaves a dead pointer. Keep the domain in **one** config constant and
reference it everywhere else, or treat a domain change as a grep-replace
checklist exercise.

---

## #3 — USB device-address cap (127 per bus) and USB 3 instability forced a hub re-architecture

**Date:** scaling decision, 2026 (post 2026-03-09 topology snapshot; targeting 95 SIMs).

**Background.** USB is a tree, and two hard limits bind it from the root:
- **127 device addresses per bus** — every hub and every modem consumes an
  address. The Orange Pi's single USB host controller is one bus, so the cap
  is 127 total devices, **not** 127 modems.
- **5 tiers max** (USB 2.0 spec) — root → hubs → hubs → hubs → modems. At
  4-port and 7-port hubs this cascades fast and the address budget runs out
  before the port count does.

The 2026-03-09 topology
([`docs/usb-topology-explained.md`](usb-topology-explained.md)) already shows
the farm at 73 modems + ~30 hubs = ~103 devices — within 127 but **near the
ceiling**, and that doc explicitly warns "to exceed 80 modems you'd need a
second Orange Pi." The `modem_id` is the `/dev/ttyUSB<n>` index, not a stable
SIM identity, so port re-enumeration churn compounds as the tree grows.

**Symptom / failure mode.**
- Hitting the 127-address cap: new modems silently fail to enumerate — they
  draw power but never get a USB address, so `lsusb` doesn't list them and the
  daemon never opens a `/dev/ttyUSB` for them. This is **not** a software
  error; the kernel simply runs out of bus addresses.
- **USB 3 instability:** EC25/EC20 modems are unreliable on USB 3
  controllers — disconnects, re-enumeration loops, and descriptor errors.
  The USB 2.0 controller was more stable, but its 127-address limit became
  the binding constraint at scale. (USB 3 raises the device-count ceiling but
  *introduces* modem instability, so it's a worse trade for this hardware.)

**Why this is insidious.** Both failures are silent. A modem that doesn't
enumerate looks identical to an empty slot from the daemon's view — there's
no error, just a missing `/dev/ttyUSB`. Operators discover it only by
comparing "SIMs expected" vs "SIMs detected," which is exactly how the
73-modems-of-78-expected discrepancy in the topology doc was found. The
daemon's `modem_id` churn (a SIM moving between ports across reboots) makes
"which SIM is missing" even harder to pin down.

**Fix (hardware decision).** Replace the deep 4/7-port cascade with fewer,
larger hubs to flatten the tree and stay under 127 addresses per bus:
- **2 × 100-port USB hubs** — carry the bulk of the 95 SIMs, each on its own
  root where possible to spread the address budget.
- **2 × 10-port USB hubs** — absorb the remainder and act as a margin for
  growth / spares.

This deliberately stays on the stable USB-2-class controller path (the 100-port
hubs are USB 2.0; the modems don't need USB 3 bandwidth — SMS is ~100 Kbps).
Two 100-port hubs on two separate buses/root ports split the address budget so
neither subtree approaches 127.

**What broke (severity).**
- 🔴 Modems above the 127-address line — **invisible** to the daemon, no SMS
  received, no error surfaced. These SIMs were dark until the re-architecture.
- 🔴 USB-3-instability disconnects — intermittent, hard to distinguish from
  physical modem faults; causes `modem_id` reassignment and lost messages mid-
  transfer.
- 🟡 Operational confusion — `modem_id` is a port index, SIMs roam between
  ports, so "modem 73" is not a stable identity. The fetch-sms flow learned
  this the hard way (see issue #1's ICCID-vs-modem_id discussion).

**How to verify the fix worked.**
1. `lsusb -t` device count: 95 modems + hubs must be **≤ 127 per bus** and
   each modem must show all 5 interfaces.
2. `lsusb -t | grep "2c7c:0125" | wc -l` = 95 × 5 = 475 interface lines.
3. Daemon's `✅ Cached modem N with ICCID …` journal lines count ≥ 95 after
   a full USB settle — compare to expected SIM inventory.
4. `dmesg | grep -iE 'usb.*error|over_current|disconnect'` quiet over a
   soak test (hours, not minutes — USB-3-style disconnects are intermittent).

**How to detect a recurrence.**
- A **SIM-inventory vs detected-modems reconciliation** job: the daemon
  already caches ICCIDs per port on startup. Compare the count of distinct
  detected ICCIDs against the expected SIM count (from D1 `sims`, or the
  planned local `sim_inventory` — see issue #1's fix). A gap means modems
  failed to enumerate. This is the same "expected vs detected" check that
  caught the 73-of-78 gap in 2026-03.
- No such reconciliation runs today — the 127-cap and USB-3 failures were
  found manually. This is the detection gap to close.

**Lesson.** The USB device-address limit is per-bus from the root, and **hubs
count against it** — "100-port hub" doesn't mean "100 free addresses below
the root." The binding constraint is addresses per bus, not socket count (this
is the one-line summary already in `orange-pi-daemon/CLAUDE.md`). Planning a
USB tree by port count alone will silently brick modems above the line.
