# Repository Agent Guide

> Multi-node SMS management platform for 100+ USB modems — Orange Pi Rust daemon → Cloudflare Workers API → Svelte 5 + Bun dashboard, with automated carrier balance queries via SMS AI and browser automation.

## Mission and Architecture

This repository operates a SIM-centric platform for collecting SMS messages from
100+ modems and querying carrier account balances:

```text
Orange Pi + EC20 modems -> Rust daemon -> Cloudflare Worker -> Svelte dashboard
                                                    |    ^
                                                   D1    |
                                                         |
                                         local macOS Balance Agent
```

Major components:

- `orange-pi-daemon/`: Rust/Tokio hardware daemon using direct AT commands.
- `sms-dashboard/client/`: Svelte 5, Tailwind, and Bun frontend.
- `sms-dashboard/server/`: Cloudflare Worker API and Auth0 authorization.
- `sms-dashboard/migrations/`: append-only D1 migrations (see latest file for current number).
- `sms-dashboard/runner-core/`: shared authenticated local-runner logic.
- `sms-dashboard/balance-agent/`: Electron menu-bar and authenticated CLI
  interfaces for AI-assisted SMS and interactive carrier-browser queries.
- `nixos-config/`: Orange Pi NixOS configuration and encrypted SOPS material.
- `flake.nix`: canonical development, validation, daemon build, and dev convenience
  commands (`dev-server`, `balance-agent`, `release-balance-agent`).
- `docs/`: architecture, operating procedures, staged plans, and evidence.

Production is `https://sexy.qzz.io`. The Cloudflare Worker is `sms-dashboard` in
account `793e3286eaca411bf1eebaf4b8c7051e`.

## Non-Negotiable Boundaries

### Secrets

- Never decrypt, print, copy, infer, validate, or edit secret values.
- Never edit `secrets/dev-vars.yaml`. It is intentionally ignored and owned by the
  user. Agents may establish that a key name exists without reading its value.
- Never inspect plaintext process environments, generated Wrangler secret files,
  keychains, tokens, cookies, `.p12` files, Apple keys, Auth0 secrets, or carrier
  sessions.
- Local Dashboard development values enter processes only through the existing
  `sops exec-env` wrapper in `flake.nix`. Balance Agent refresh and AI tokens use
  the operating-system credential store. Do not create plaintext `.env` files or
  put secret values on command lines.
- Do not invoke a secret-consuming runner merely to test it. The user must
  explicitly authorize the exact live operation.
- Never commit generated secrets, browser profiles, logs containing credentials,
  build output, `node_modules`, `dist`, or `balance-agent/release`.

### Production Side Effects

- Do not send a real SMS, start a balance query, launch a fleet batch, recharge a
  SIM, change an Auth0 tenant, mutate production D1, or deploy unless the user has
  explicitly requested that operation.
- Tests must use fixtures/mocks. They must not consume carrier traffic or claim
  live Balance Agent jobs.
- Human verification is an operator handoff. Never automate CAPTCHA, slider, or
  image-challenge bypasses.
- Follow the approval gates in `docs/sms-hardware-storage-safety-plan.md`. Do not
  opportunistically change physical-message deletion or modem storage behavior.

### Worktree and Scope

- The worktree may contain user changes. Never revert, overwrite, or clean them.
- Work directly on `main` unless the user asks for another branch. Do not create a
  branch just for routine work.
- Keep changes inside the component that owns the behavior. Avoid unrelated
  refactors and generated metadata churn.
- Use `apply_patch` for manual edits. Use `rg`/`rg --files` for discovery.

## Core Data and Authorization Contracts

- `sims` is the user-owned inventory and the source of truth for ICCID, phone
  number, carrier, SIM index, and assigned IMEI. The daemon never writes it.
- `sims.service_type` is manually verified `unknown`/`prepaid`/`postpaid` metadata.
  Never infer or write it from ICCID, detected operator, or balance replies.
- Read device/SIM state through `device_view`, not ad hoc joins or legacy tables.
- `device_view` joins `sims.imei` to `modems.equipment_id`. The join key is IMEI,
  not ICCID.
- Use `modems.detected_iccid`; `modems.current_iccid` is stale legacy data.
- `modem_state` was removed by migration `033`; signal fields live on `modems`.
- The v8 daemon syncs through `/api/control/devices`. The pre-`033`
  `/api/control/phones` route was removed; do not reintroduce it.
- SIM indices are displayed as `S` plus two digits (`S01`, `S36`) everywhere.
  Reuse the centralized formatter instead of formatting individual views.
- Daemon health and SIM state are different domains. A healthy daemon can report
  offline SIMs; legacy activity must not make a schema-v1 daemon healthy.

Authentication contracts:

- Browser users authenticate with Auth0 JWTs and RBAC. Daemon/legacy control
  clients authenticate with `API_KEY`.
- Middleware order is CORS -> Auth0 JWT -> RBAC.
- Balance Agent requires scopes `balance:runners:heartbeat`,
  `balance:skills:run`, and `balance:browser:run`.
- Migration `057` binds Dashboard-created balance work to the requesting Auth0
  `sub` via `sim_balance_checks.requested_by_subject`.
- An Auth0 Balance Agent may see, claim, and mutate only work owned by the same
  Auth0 `sub`. A different user's online Agent must not satisfy preflight or claim
  that work.
- `NULL` ownership is reserved for legacy API-key jobs. Do not weaken this
  compatibility boundary.

## Development Environment

Use Nix as the canonical tool entry point. With direnv active, the commands below
are on `PATH`; otherwise prefix them with `nix develop --command`.

### Dashboard lifecycle

```bash
dev-server restart
dev-server status
dev-server logs
dev-server stop
```

- `dev-server` owns exactly one frontend on `127.0.0.1:8080` and one Wrangler API
  on `:8787`.
- After dashboard edits, use `dev-server restart`. Do not start extra `vite`,
  `bun run dev`, or `wrangler dev` processes alongside it.
- Leave the foreground supervisor running when the user asks to keep localhost
  available. Before finishing, verify both ports and `http://127.0.0.1:8787/api/health`.
- `dev-frontend` and `dev-api` are for isolated debugging only.

### Focused commands

```bash
cd sms-dashboard
bun install
bun run test
bun run build

cd sms-dashboard/balance-agent
bun install
bun run test
bun run build
bun run start
bun run cli -- --help

cd orange-pi-daemon
cargo build --release
check-daemon
```

Use Bun, not npm/pnpm/yarn. There is no repository-wide JavaScript lint script.
Match the local style and make Rust changes pass `check-daemon`, including rustfmt.

## Verification Matrix

Scale verification to the changed surface:

- Documentation/config only: `git diff --check` plus targeted consistency checks.
- Worker/server behavior: focused tests, then `cd sms-dashboard && bun run test`.
- Frontend behavior: dashboard tests and `bun run build`; inspect desktop and
  440px mobile layouts with Playwright when layout or navigation changes.
- Balance Agent: `bun run test && bun run build`; exercise menu-bar lifecycle and
  destroyed-window recovery for lifecycle changes, and use mock credentials/jobs
  for CLI tests.
- Rust daemon: `nix develop --command check-daemon`. Do not replace this with only
  `cargo check`.
- Cross-component contracts: run every affected component's gate.

Report warnings separately from failures. Existing Svelte accessibility warnings
do not justify introducing new ones; add accessible labels and keyboard behavior
when touching the relevant controls.

## UI Product Rules

- Desktop operational screens should be dense, quiet, and optimized for scanning.
- On mobile, primary pages such as messages, devices, balances, rules, filters, and
  users use edge-to-edge content below the header rather than desktop cards with
  outer gaps.
- Preserve the mobile bottom navigation on standalone routes, including Send.
- Search filters the record set; do not paint every matching substring with an
  orange highlight.
- Device and balance tables retain sortable headers and carrier/region filters.
- Keep sender and receiving SIM information visually adjacent in message rows.
- Verification-code classification requires semantic OTP context. A bare number
  in marketing or service instructions is not enough.
- Clicking a verification code copies it and provides an explicit copy toast or
  equivalent feedback, not only a color change.
- Do not show balances in the Device and SIM table; balances belong to the Balance
  module.

## D1 Migrations

- Add a new numbered migration; never rewrite an applied migration.
- Production predates Wrangler migration bookkeeping. Do **not** run
  `wrangler d1 migrations apply --remote`, because it may attempt historical files
  that were already applied directly.
- Before a production schema change, inspect the remote schema and active jobs
  with read-only queries. Apply only the exact new migration file:

```bash
cd sms-dashboard
CLOUDFLARE_ACCOUNT_ID=793e3286eaca411bf1eebaf4b8c7051e \
  bunx wrangler d1 execute sms-dashboard --remote --file=migrations/NNN_name.sql
```

- Prefer additive, backward-compatible migrations. Deploy in the order migration
  -> Worker/frontend -> daemon when a contract spans components.
- Never run destructive production SQL without an explicit backup/rollback plan
  and user authorization.

## Deployment

### Cloudflare Dashboard

1. Run `bunx wrangler whoami`.
2. Confirm the login is a Google-authenticated `@bitgc.io` identity and the target
   account is `793e3286eaca411bf1eebaf4b8c7051e`.
3. Apply only the exact required D1 migration as described above.
4. Deploy from `sms-dashboard`:

```bash
CLOUDFLARE_ACCOUNT_ID=793e3286eaca411bf1eebaf4b8c7051e bun run deploy
```

5. Record the Worker version and verify
   `https://sexy.qzz.io/api/health` plus the affected authenticated workflow.

### Orange Pi daemon

- The verified target is `root@10.171.150.102` on the office/internal network.
- The historical public address is not a verified authenticated deployment target.
- When FortiClient owns the broad route, the documented host route may require a
  user-approved administrator action. Do not repeatedly prompt for it or claim a
  deployment succeeded when SSH is unavailable.
- After `check-daemon`, deploy from the repository root only when the host is
  reachable:

```bash
nixos-rebuild switch --flake .#orange-pi \
  --target-host root@10.171.150.102 \
  --build-host root@10.171.150.102 \
  --use-substitutes --impure
```

- Verify `sms-daemon` is active, inspect recent journal errors, and wait for a fresh
  production heartbeat.

## Balance Agent Runtime and Release

- Balance Agent is an internal team utility, not a public App Store product.
- AI and browser capability loops are independent and concurrency is one per loop.
  Browser jobs are serial because a human-verification task can hold the visible
  browser until completion or timeout.
- The company AI token and carrier browser cookies remain local. They never go to
  Cloudflare, D1, the Orange Pi, application logs, or crash reports.
- The browser uses a temporary local profile, disables password-save and notification
  prompts, and exposes human verification rather than hiding the window.

Release policy:

- All packaging and release commands must be owned by `flake.nix`.
- The intended interfaces are `nix build .#balance-agent` and
  `nix run .#release-balance-agent -- <version>`. They are not complete until those
  flake outputs exist and have been tested; do not claim a release is available
  before then.
- Build a macOS `.dmg` and `.zip`, apply an ad-hoc signature, and emit SHA-256
  checksums. Start with Apple Silicon; add other architectures only for real users.
- Publish artifacts only as a prerelease/release in the private
  `stars-labs/message-dashboard` GitHub repository. Users must authenticate to
  GitHub to download them.
- Do not place GitHub tokens or signing material in the Nix store. Inject release
  credentials at execution time.
- Because the internal build is not Developer ID signed or notarized, document the
  one-time Finder **Open** Gatekeeper override.
- Do not implement silent automatic updates for ad-hoc-signed builds. Update
  detection may open the private GitHub Release page for an explicit manual install.
- If distribution expands beyond the trusted team, require an organization-owned
  Apple Developer account, Developer ID signing, and notarization before release.

## Documentation Discipline

- Keep `AGENTS.md` and the relevant architecture/operation document aligned when
  contracts change.
- Treat dated fleet counts and USB measurements as historical snapshots, not live
  truth. Query production when current state matters and label the observation date.
- Document commands that actually exist. Mark planned flake outputs and release
  automation as planned until implemented and verified.
