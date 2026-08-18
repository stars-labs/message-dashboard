# Balance Agent — Agent Guide

> Electron menu-bar app + authenticated CLI for carrier balance queries.
> Runs locally on macOS; talks to the Dashboard API via Auth0.

## Capabilities

| Capability | Method | Requires |
|---|---|---|
| `sms-ai` | Company AI parses carrier SMS menus | Company VPN + AI URL + Keychain token |
| `unicom-browser` | Playwright Chrome → Unicom website → OTP → balance | Visible Chrome + Auth0 login |

Both loops are serial (one job at a time). Keep Unicom browser batches ≤ 5 cards —
Unicom rate-limits rapid logins with a CAPTCHA lockout.

## Trust boundaries

- Auth0 tokens and AI tokens: macOS Keychain only — never Cloudflare, D1, or daemon.
- Browser profiles are temporary. Human verification is an operator handoff — never
  automate CAPTCHA or slider bypasses.
- A runner may only claim jobs matching its own Auth0 `sub`.

## Build and run

```bash
cd sms-dashboard/balance-agent
bun run test
bun run start         # build + launch Electron

bun run cli -- --help # CLI from source
```

## Shared code

`runner-core/` and `server/utils/` are shared with the dashboard. Use relative
imports (`../../runner-core/...`). Do not copy these files.

## Release

See [docs/deployment.md](../../docs/deployment.md) and
[docs/balance-agent-product-plan.md](../../docs/balance-agent-product-plan.md).
