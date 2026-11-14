# Balance Agent — Agent Guide

> Electron menu-bar app + authenticated CLI for carrier balance queries.
> Runs locally on macOS; talks to the Dashboard API via Auth0.

## Capabilities

| Capability | Method | Requires |
|---|---|---|
| `sms-ai` | Company AI parses carrier SMS menus | Company VPN + AI URL + Keychain token |
| `carrier-browser` | Playwright Chrome → carrier portal → OTP → balance/expiry | Visible Chrome + Auth0 login |

Both loops are serial (one job at a time). Carrier profiles own their login
cooldown; keep browser batches small because carrier OTP endpoints rate-limit.

## Trust boundaries

- Auth0 tokens and AI tokens: macOS Keychain only — never Cloudflare, D1, or daemon.
- Browser profiles are temporary. Human verification is an operator handoff — never
  automate CAPTCHA or slider bypasses.
- A runner may only claim jobs matching its own Auth0 `sub`.

## Build and run

```bash
cd sms-dashboard/balance-agent
bun run check         # typecheck + test + build; the dashboard's check runs it too
bun run test
bun run start         # build + launch Electron

bun run cli -- --help # CLI from source
```

## Layout

Strict TypeScript, one project per runtime (`tsconfig.json` lists them):

| Project | Files | Runs in |
|---|---|---|
| `tsconfig.main.json` | `src/main.ts`, `src/cli.ts`, `src/runner/` | Electron main process, Bun |
| `tsconfig.preload.json` | `src/preload.ts` | Sandboxed preload (bundled to CommonJS) |
| `tsconfig.renderer.json` | `src/renderer/` | Settings window (DOM only) |
| `tsconfig.contract.json` | `src/ipc/` | All three: IPC schemas and types |
| `tsconfig.test.json` | `*.test.ts` | Bun |
| `tsconfig.tooling.json` | `scripts/` | Bun |

`scripts/build.ts` bundles `main.ts` (ESM), `preload.ts` (CommonJS, because a
sandboxed preload cannot `import`) and `renderer/renderer.ts` into `dist/`.
`runner/` holds the control client, presence and capabilities; only this package
uses it.

## Boundaries

The renderer is untrusted. Every IPC payload is `unknown` in `main.ts` until a
valibot schema from `src/ipc/contract.ts` parses it; the preload parses what main
sends back. Settings files, Keychain output, argv and HTTP answers are parsed the
same way.

## Shared code

`../shared/` is shared with the dashboard. Use relative imports
(`../../shared/...`); the `.js` specifiers resolve to the `.ts` sources. A change
to a shared contract must pass the dashboard's `bun run check`, which runs this
package's `check`. Do not copy these files.

## Release

See [docs/deployment.md](../../docs/deployment.md) and
[docs/balance-agent-product-plan.md](../../docs/balance-agent-product-plan.md).
