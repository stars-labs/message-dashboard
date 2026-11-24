# Repository Agent Guide

> Multi-node SMS management platform for 100+ USB modems — Orange Pi Rust daemon → Cloudflare Workers API → Svelte 5 + Bun dashboard, with automated carrier balance queries via SMS AI and browser automation.

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

## Git hooks

Entering the dev shell (`nix develop`) installs them from `flake.nix`
(`pre-commit.settings.hooks`); a worktree needs its own `nix develop` once, and
until then its commits fail. Never skip them with `--no-verify`.

- **pre-commit**, on staged files: prettier and ESLint for `sms-dashboard/`,
  `cargo fmt --check` for `orange-pi-daemon/`, `check-nix` (nixfmt, deadnix,
  statix) for `.nix` files. `nix fmt` formats every Nix file.
- **pre-push**, on the files the pushed commits change: `bun run check` for
  `sms-dashboard/`, `check-daemon` for the daemon and its control fixtures, the
  Orange Pi system eval for `flake.*` and `nixos-config/`, and `audit-deps` when a
  manifest or lockfile changes. `bun run e2e` is not a hook; run it for client or
  server changes.

`audit-deps` (needs the network) runs `cargo deny check` in the daemon
(`deny.toml`: advisories, licenses, sources) and `bun run audit` in the dashboard.
An advisory is accepted only with a reason: `[advisories] ignore` in `deny.toml`,
`ACCEPTED` in `sms-dashboard/scripts/audit.ts`. An accepted npm advisory that is
no longer reported fails too, so remove it once fixed.

## Reference docs

- [Data model & auth contracts](docs/data-contracts.md)
- [Deployment procedures](docs/deployment.md)
- [Balance Agent CLI](docs/balance-agent-cli.md)
- [Balance Agent release plan](docs/balance-agent-product-plan.md)
- [SMS hardware safety](docs/sms-hardware-storage-safety-plan.md)
- [Voice call plan](docs/voice-call-plan.md)
- [USB topology](docs/usb-topology-explained.md)
