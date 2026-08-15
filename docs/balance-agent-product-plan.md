# Balance Agent Productization Plan

## Status

Approved on 2026-08-15. Stage 1 is implemented locally. Stage 2 now has a shared
control client, presence heartbeat, cancellable serial scheduler, SMS AI capability,
and the complete browser workflow including OTP and human-verification handoff. The
development scripts are thin adapters; a live pilot remains pending. Stage 3 has a
locally launchable and packageable Electron application with Auth0 Device Flow,
encrypted local credentials, settings, tray lifecycle, custom protocol registration,
separate capability loops, notifications, a hermetic Playwright Chromium, and
independent in-app checks for Dashboard authentication, company AI/VPN, and the
browser runtime.
Auth0 tenant setup, signing, notarization, production migration, deployment, and
clean-machine pilot remain pending. The Dashboard now blocks unattended single
queries behind capability preflight, can launch the Agent protocol, warns before
interactive browser work, and requires explicit batch method selection with
browser jobs off by default. Batch IDs, progress, and cancellation are not yet
implemented. This document does not authorize enabling browser queries for the
full fleet.

## Goal

Deliver one desktop application that lets a normal operator run every supported
balance-query workflow without installing Bun, Nix, SOPS, or using a terminal.
The dashboard must know whether the application is ready before it creates work,
show when human verification is required, and explain the impact of a batch before
the operator confirms it.

The existing scripts remain supported developer and diagnostic entry points. Their
business logic will move into shared modules used by both the scripts and the
desktop application so the product does not create a second implementation.

## Current Behavior

There are currently two local Bun processes:

| Runner | Responsibility | Local requirements |
| --- | --- | --- |
| `balance-skill-runner.js` | Interpret unresolved carrier SMS menus and choose a validated read-only follow-up | Company VPN, AI URL, token, model and API key |
| `unicom-balance-runner.js` | Open the official China Unicom website, use an SMS one-time password, pause for human verification, and read the balance | Visible Chrome and API key |

`flake.nix` adds secret injection, process locks, PID files, logs and service
commands. This is appropriate for development but is not the end-user interface.

Both runners currently claim exactly one task, finish or release it, and then claim
the next task. A single-instance lock prevents a second copy on the same machine.
Therefore:

- AI jobs are processed serially by one local AI runner.
- Browser jobs are processed serially by one local browser runner.
- A browser job waiting for a slider or image challenge blocks that runner until
  completion or the 15-minute human-verification timeout.
- Multiple machines could process separate jobs concurrently because D1 leases one
  job to one runner, but there is no product UI for managing those machines today.
- A batch queues eligible checks in D1; it does not execute them inside the HTTP
  request. SMS, AI and browser consumers process their respective queues later.
- A discovery-only browser profile is excluded from a fleet batch until that exact
  SIM/profile pair has previously produced a parsed result.

## Product Decisions

### One desktop agent

Ship one application named **Balance Agent**, not one application per runner. The
application hosts capability modules:

- `sms-ai`: company-AI interpretation of carrier SMS conversations.
- `unicom-browser`: visible official-site login and read-only balance retrieval.
- Future carrier browser or API capabilities can be added without changing the
  installation and pairing flow.

The first supported release is a signed and notarized macOS application because
the current operator environment and browser pilot are macOS. Keep the protocol
and core modules platform-neutral so Windows can follow without changing Worker
APIs or task state.

Use Electron for the first desktop release. It supplies a packaged Node runtime,
tray UI, settings windows, notifications, custom-protocol handling and mature
packaging. Bundle a pinned Playwright-compatible Chromium runtime so users do not
need Bun, Nix, a repository checkout, or a particular system Chrome version. The
larger installer is an accepted tradeoff for deterministic browser behavior.

### Local configuration and secrets

The settings UI collects:

- Company AI base URL.
- AI protocol and model.
- AI token.
- Optional organization-specific network guidance.

Store refresh tokens and AI tokens in the operating-system credential store. Never
write them to application configuration, logs, crash reports or D1. Non-secret
settings may use the application data directory.

The settings screen provides a **Test configuration** action that independently reports:

- Dashboard authentication and Worker reachability.
- VPN/company-AI endpoint reachability.
- AI authentication, protocol and model validity.
- Bundled browser availability.

An unavailable company VPN disables only `sms-ai`; it must not make browser-only
or non-AI capabilities appear offline.

### Authentication

Do not distribute the current global `API_KEY` with the desktop product. Register
Balance Agent as an Auth0 native application and use Device Authorization Flow.
Store its refresh token in the OS credential store and request only runner scopes.
The Worker validates the access token, operator organization and capability scope
on every control request.

Dashboard-created balance checks store the requesting Auth0 `sub`. Device-token
runners may see and claim only checks with the same `sub`, and every lease mutation
revalidates that owner. API-key compatibility jobs retain a `NULL` owner and are
visible only to legacy API-key runners. Runner status and preflight responses are
filtered by the authenticated Dashboard user's `sub` as well, so another user's
online Agent cannot satisfy readiness or receive the task.

If the Auth0 tenant cannot enable Device Authorization Flow, use a one-time pairing
code generated by an authenticated administrator as a temporary fallback. Do not
invent a long-lived shared desktop secret.

Each installation receives a stable runner ID and can be revoked independently.
The dashboard must display its name, platform, application version, capabilities,
last heartbeat and revocation state.

### Control plane and heartbeat

Add a runner control plane rather than inferring availability from pending jobs.
A connected agent sends a heartbeat every 30 seconds containing:

- Runner ID, application version and platform.
- Supported capabilities and per-capability health.
- Current job ID and state, without OTPs, cookies or AI credentials.
- Browser concurrency and whether the operator is present.

Treat a runner as unavailable after 90 seconds without a heartbeat. Heartbeat
records are operational state and may expire; audit events remain durable.

Recommended runner states:

```text
offline -> starting -> ready -> busy
                         |       +-> human_verification_required
                         +-> degraded
                         +-> configuration_required
```

The existing job lease remains the source of truth for ownership. Heartbeats do
not replace compare-and-set claims, lease renewal or terminal job states.

### Browser and AI concurrency

The first product release uses these limits:

- Browser capability: concurrency `1`, not user-configurable.
- AI capability: concurrency `1` initially; raise it only after rate-limit and
  ordering tests.
- One application may service both capabilities without one queue blocking the
  other. They run as separate workers inside the same desktop process.

Browser concurrency stays at one because multiple visible OTP/captcha windows make
it easy to act on the wrong SIM. A human-verification task blocks only the browser
worker, not the AI worker. FIFO is the default within a capability, with an
explicit operator-triggered single-SIM query allowed to take priority over an
unstarted monthly batch task.

Do not automatically bypass, outsource or solve carrier human-verification
challenges. The application focuses the correct window, displays the SIM index and
masked number, sends a desktop notification, and renews the lease while the user
completes the challenge.

## Dashboard Experience

### Agent status

Add a compact status surface to the Balance page:

```text
Balance Agent       Online
SMS AI              Ready
Browser queries     Ready
Needs attention     1
```

It opens a detail panel with installation name, version, last heartbeat, VPN/AI
health, current task and pending task counts. Status text must distinguish
`runner offline` from `VPN unavailable` and `human action required`.

Register a `message-dashboard-runner://` custom protocol. **Open Balance Agent**
uses that protocol to launch or focus an installed application. If the protocol is
not handled, show the signed installer download and setup instructions. The web
application must not depend on an unauthenticated localhost HTTP endpoint.

### Single-SIM query

Before creating a task, the dashboard retrieves a query preflight containing the
selected method and required capability.

- For ordinary SMS, show the existing confirmation.
- For AI-assisted SMS, require an online `sms-ai` capability. If it is unavailable,
  offer to open Balance Agent and explain whether VPN or configuration is missing.
- For browser queries, require an online `unicom-browser` capability and show:
  "The official carrier website will open on your computer. You may need to
  complete a slider or image verification before the query can continue."

The primary action becomes **Open agent and query** when the relevant capability
is offline. The default behavior is not to create work that no runner can service.
An administrator may deliberately choose **Queue anyway** for durable deferred
execution; this is a secondary action and must show that the result will wait.

### Batch query

Replace the single eligible count with a method-aware preview:

```text
Direct SMS                         28
AI-assisted SMS                    14
Browser login                       6
May require human verification      6
Cooldown                            3
Offline                             2
Unsupported                        42
```

Provide separate selections for direct SMS, AI-assisted SMS and browser login.
Browser login is unchecked by default and requires an explicit confirmation. The
preview shows whether a compatible agent is online and estimates browser handling
as sequential, for example "6 browser queries, processed one at a time."

The batch endpoint must receive the confirmed method set and an immutable preview
token or equivalent server-side plan version. It must not silently add a browser
category that was absent from the confirmation. Queue insertion remains one
audited transaction per SIM so one failure does not roll back the fleet action.

### Query status

Use one vocabulary across the overview, query history, desktop application and
notifications:

| Product label | Meaning |
| --- | --- |
| Waiting for agent | Durable task exists but no compatible runner owns it |
| Queued | A compatible runner is online and the task awaits its turn |
| Querying | Runner owns and is actively processing the task |
| Waiting for code | Browser requested an OTP and is waiting for the correlated SMS |
| Human verification | The correct local browser window needs operator action |
| Parsing | Reply or browser response is being validated |
| Completed | A normalized balance metric was stored |
| Failed | Terminal failure with a safe retry or manual-action explanation |

The desktop application and web dashboard both link to the same audit timeline.
Neither surface exposes raw carrier cookies, passwords, OTPs or AI tokens.

## Server Changes

Introduce the minimum durable concepts needed by the product:

- Runner installations and revocation state.
- Ephemeral capability heartbeat/current-state records.
- Required capability and priority on local-runner jobs.
- Batch membership and the confirmed method categories.
- Runner assignment in job audit events.

Reuse `sim_balance_checks`, `sim_balance_skill_jobs`, `sim_balance_web_jobs` and
their existing lease semantics. Do not create a second balance data model.

New endpoints should cover:

- Device enrollment/authentication.
- Heartbeat and capability reporting.
- Capability-aware job claim and lease renewal.
- Runner status for authenticated dashboard users.
- Single and batch preflight.
- Human-attention acknowledgement and application focus metadata.

All claim, renewal, completion and failure operations remain idempotent. A stale
runner cannot complete a job after its lease has moved to another installation.

## Local Architecture

Extract the current scripts into modules with no dependency on command-line
arguments or process-global configuration:

```text
desktop/
  main/                 Electron lifecycle, tray, updates, protocol and keychain
  renderer/             Settings, status, task list and diagnostics
runner-core/
  control-client.js     Authenticated heartbeat, claim and lease protocol
  presence.js           Capability lifecycle heartbeat
  serial-runner.js      Cancellable concurrency-one execution loop
  capabilities/
    sms-ai.js
    unicom-browser.js
    unicom-browser-workflow.js
scripts/
  balance-skill-runner.js       Development adapter around runner-core
  unicom-balance-runner.js      Development adapter around runner-core
balance-agent/
  src/                  Electron main, isolated preload, Auth0 and renderer
  scripts/build.mjs     Bundles shared core into the desktop application
```

Use one structured, redacted logging API. Every log field is allowlisted; arbitrary
HTTP request headers, page storage, carrier responses and environment dumps are
excluded. Diagnostic screenshots require an explicit operator action and a visible
warning because carrier pages may contain personal information.

Temporary browser profiles are created per task, disable password saving and
autofill, and are deleted after the browser context closes. Navigation and data
extraction are restricted to an allowlist of official carrier origins and response
schemas.

## Delivery Stages

### Stage 1: Protocol and observability

- Add runner identity, Auth0 scopes, heartbeat and capability models.
- Add status and preflight APIs without changing current query buttons.
- Report existing script runners through the new protocol.
- Add expiry, revocation, lease-race and redaction tests.

**Exit criteria:** the dashboard API can accurately say which capabilities are
ready, degraded or offline, and existing scripts still process current tasks.

Implementation uses the following future Auth0 native-client scopes while keeping
the shared API key only as a compatibility path for the current scripts:

- `balance:runners:heartbeat`
- `balance:skills:run`
- `balance:browser:run`

### Stage 2: Shared runner core

- Extract control-client, AI and browser logic from the executable scripts.
- Keep current script commands as thin adapters.
- Separate AI and browser worker loops so human verification cannot block AI work.
- Add deterministic tests for cancellation, restart, lease loss and partial batch
  queues.

**Exit criteria:** scripts pass existing live pilot workflows using shared modules,
with no behavior regression and no secret appearing in logs.

### Stage 3: Desktop MVP

- Build the signed macOS Electron application.
- Implement Auth0 device login, OS credential storage and configuration checks.
- Add tray status, start-at-login control, task view, notifications and the bundled
  browser runtime.
- Register the custom protocol and implement safe focus behavior.

**Exit criteria:** a clean Mac can install the application, pair it, configure AI,
and complete one AI-assisted and one human-assisted browser query without a repo,
terminal, Nix, Bun or SOPS.

### Stage 4: Dashboard integration

- Add agent status and diagnostics panel.
- Add capability-aware single-query preflight and launch/download guidance.
- Add unified task labels and human-attention state.
- Keep an administrator-only queue-anyway escape hatch.

**Exit criteria:** an operator cannot accidentally start an interactive query
without being told which local capability and manual action it requires.

### Stage 5: Safe batch workflow

- Add method-aware batch preview and explicit category selection.
- Default browser jobs off and state that they are sequential.
- Add batch IDs, progress, cancellation of unstarted jobs and per-category counts.
- Test runner loss, VPN loss, application restart and human-verification timeout
  during a mixed batch.

**Exit criteria:** a mixed batch never opens parallel browser challenges, does not
block AI work, and can resume safely after restarting Balance Agent.

### Stage 6: Release and operations

- Add signed update manifests, staged rollout and rollback.
- Define supported macOS and browser-runtime versions.
- Add privacy-reviewed diagnostics and retention limits.
- Pilot on one operator machine before enabling monthly fleet scheduling.

**Exit criteria:** the application has an owned release process, revocable device
access, documented support diagnostics and a tested rollback path.

## Verification Matrix

Before general release, verify at least:

- Agent absent, offline, outdated, revoked and misconfigured.
- VPN disconnected before and during an AI job.
- AI timeout, malformed decision, authentication failure and rate limiting.
- Browser close before OTP, after OTP and during human verification.
- Wrong-SIM OTP, stale OTP, duplicate OTP and expired lease.
- Application and machine restart with queued and leased work.
- A mixed batch containing direct SMS, AI, browser, cooldown, offline and
  unsupported SIMs.
- Two runner installations competing for the same job.
- Logs, crash reports and D1 records contain no local secret or carrier session.

## Explicit Non-Goals

The first release does not:

- Automatically solve or bypass carrier human verification.
- Run carrier browser sessions in Cloudflare or another remote browser.
- Automate recharge or payment.
- Enable more than one browser job at a time.
- Replace deterministic carrier allowlists with unrestricted AI actions.
- Remove the existing developer scripts until the desktop agent has completed its
  pilot and rollback period.

## First Implementation Slice

Start with Stage 1 only. It has the smallest operational risk and gives the web UI
the information needed to stop creating opaque, unattended local tasks. Do not
start Electron packaging until runner identity, heartbeat, capability health and
preflight response shapes are tested and agreed.
