# Repository Agent Guide

> Multi-node SMS management platform for 100+ USB modems — Orange Pi Rust daemon → Cloudflare Workers API → Svelte 5 + Bun dashboard, with automated carrier balance queries via SMS AI and browser automation.

## Code Principles

Each rule is a trigger and a required action. Rules marked (test) are meant to
be enforced by `bun test`; until those tests land, treat them as review
questions. A change that breaks a rule must say why in its commit message.

**One owner per state**
- Writing a D1 table, store, or cache you don't own → call its owner instead.
  Owners: [docs/data-contracts.md](docs/data-contracts.md). Caches (Pi SQLite,
  IndexedDB) are never a source of truth.
- Adding state or a new domain to `App.svelte` → not allowed; it may only
  shrink. (test: line count never grows)

**Pure core, thin shell**
- Adding a branch (`if`/`switch`/ternary) that decides a value inside a
  `.svelte` file, handler, or Tokio task → move it to a pure function with a
  test beside it. Pure = no fetch, D1, DOM, timers, or `Date.now()`.
- Testing code around a side effect → inject the effect as a parameter
  (`createCallSession(deps)`); no global mocks.

**One way to do each thing**
- Client HTTP → `lib/api.js` only; `lib/auth.js` owns the session probe.
  Components use `api.get/post/put/delete`; named methods only add behaviour.
  (test: `client/http-boundary.test.js`)
- Client state → Svelte 5 runes; shared state lives in a `.svelte.js` module.
  (test: `client/state-model.test.js`)
- Replacing a helper → migrate every caller and delete the old one in the
  same commit.

**Simplest thing that works**
- Adding a class, factory, wrapper, or config switch → the same commit shows
  its second real caller or its test seam. Otherwise inline it.
- No comments that name a pattern or principle in place of a reason.

## Architecture

```text
Orange Pi + EC20 modems -> Rust daemon -> Cloudflare Worker -> Svelte dashboard
                                                    |    ^
                                                   D1    |
                                                         |
                                         local macOS Balance Agent
```

## Components

| Directory | What it is | Agent guide |
|---|---|---|
| `orange-pi-daemon/` | Rust/Tokio daemon, direct AT commands | [AGENTS.md](orange-pi-daemon/AGENTS.md) |
| `sms-dashboard/client/` | Svelte 5 + Tailwind + Bun SPA | [AGENTS.md](sms-dashboard/AGENTS.md) |
| `sms-dashboard/server/` | Cloudflare Worker API + Auth0 | [AGENTS.md](sms-dashboard/AGENTS.md) |
| `sms-dashboard/migrations/` | Append-only D1 SQL migrations | [AGENTS.md](sms-dashboard/AGENTS.md) |
| `sms-dashboard/runner-core/` | Shared authenticated runner logic | [AGENTS.md](sms-dashboard/AGENTS.md) |
| `sms-dashboard/balance-agent/` | Electron app + CLI, balance queries | [AGENTS.md](sms-dashboard/balance-agent/AGENTS.md) |
| `nixos-config/` | Orange Pi NixOS config + SOPS secrets | — |
| `flake.nix` | Dev shell, build, and release commands | — |
| `docs/` | Architecture, plans, and reference | [docs/](docs/) |

Production: `https://sexy.itoken.world` · Cloudflare account `793e3286eaca411bf1eebaf4b8c7051e`

## Hard Boundaries

**Secrets** — Never decrypt, print, copy, infer, or edit secret values. Never read
`secrets/dev-vars.yaml`. Dev secrets enter processes only via `sops exec-env`. No
plaintext `.env` files. Never commit secrets, browser profiles, `node_modules`,
`dist`, or `balance-agent/release`.

**Production** — Do not send SMS, query balances, mutate production D1, or deploy
unless explicitly requested. Tests use fixtures/mocks only. Never automate CAPTCHA
or slider bypasses — human verification is an operator handoff.

**Scope** — Never revert or overwrite user changes. Keep changes inside the
component that owns the behavior.

## Reference docs

- [Data model & auth contracts](docs/data-contracts.md)
- [Deployment procedures](docs/deployment.md)
- [Balance Agent CLI](docs/balance-agent-cli.md)
- [Balance Agent release plan](docs/balance-agent-product-plan.md)
- [SMS hardware safety](docs/sms-hardware-storage-safety-plan.md)
- [Voice call plan](docs/voice-call-plan.md)
- [USB topology](docs/usb-topology-explained.md)
