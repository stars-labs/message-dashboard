---
name: verify
description: "Prove a change works by driving the real apps the way a user does: the Svelte dashboard on the real Worker, the Balance Agent CLI and menu-bar app, and the Orange Pi daemon's control calls, on an isolated local D1 with fake Auth0 and a fake company AI, with screenshots, D1 rows and a Playwright trace as evidence. Use after changing sms-dashboard/ (client, server, shared, balance-agent) or the daemon's control protocol, before calling a fix or feature done, or for a broad regression sweep. Never touches production, real SMS, carriers or the Orange Pi."
---

# Verify

Drive the running app, exercise the feature the way a user would, and keep evidence a
skeptical reviewer would accept. `bun run test` proves units and `bun run e2e` proves
every view renders; this proves *behavior*: the click, what the user sees after it,
and what it wrote.

All commands run from `sms-dashboard/`.

## The model: one finite run per journey

There is no long-lived instance to start, attach to or forget. Each run is one
foreground command that builds the frontend, starts a fresh stack, runs your journey,
and tears everything down:

- the real Worker under `wrangler dev --local`, on a free port;
- a fresh local D1 built from the baseline plus every newer migration, then
  `scripts/e2e/seed.sql`;
- a fake Auth0 tenant (`scripts/e2e/fake-auth0.ts`): an admin browser session, device
  login for the Balance Agent, and the Management API;
- a fake company AI (`scripts/e2e/fake-ai.ts`) for the Balance Agent's `sms-ai`.

On demand, a journey also gets the two clients the Worker cannot roll back with it:
the Orange Pi daemon's control calls (replayed by the journey), and the Balance Agent,
as a CLI in its own config, state and Keychain service, or as the menu-bar app in its
own user-data dir.

Nothing in a run can reach Cloudflare, Auth0, the Orange Pi, a carrier or a phone:
there is no real daemon, so a "sent" SMS only lands in D1. `doctor` fails if
`wrangler.toml` ever gains a remote binding.

## Doctor

```bash
bun run verify -- doctor
```

Read-only. Fails on a remote binding in `wrangler.toml`; a stack, agent or app
process, temp dir or Keychain item left by an earlier run; or a missing Chromium. Run
it first, and again after any run that ended oddly. Kill a leftover by the PID it
prints, never by name, after checking what that PID is. Its process check reads `ps`,
so run it on its own: a shell line that mentions a run's temp path flags itself.

## Drive

Write a journey for the change, in this session's scratchpad (not the repo), then run
it:

```bash
bun run verify -- --journey <scratchpad>/journeys/<name>.ts --out <scratchpad>/verify-out/<name>
```

A journey default-exports one async function (contract:
`scripts/verify/journey.ts`):

```ts
import type { Journey } from '/abs/path/to/sms-dashboard/scripts/verify/journey.ts';

const journey: Journey = async ({ stack, ai, page, evidence }) => {
  const p = await page('desktop'); // or 'mobile' (440px); signed in as the admin
  await p.goto(`${stack.baseUrl}/#dashboard`);
  await p.getByRole('button', { name: '482913', exact: true }).click();
  await p.getByRole('status').filter({ hasText: '482913' }).waitFor();
  await evidence('rows', await stack.d1('SELECT id, status FROM messages'));
};
export default journey;
```

- `page(viewport)`: a blank signed-in page. Every console error or warning, page
  error, failed request or 4xx/5xx on it fails the run.
- `stack.d1(sql)`: rows from the run's local D1, for side effects. Read after the UI
  shows its end state.
- `stack.baseUrl`, `stack.apiKey` (what the daemon sends as `x-api-key`), `stack.auth0`
  (`domain`, `audience`, `nativeClientId` of the fake tenant).
- `daemon(path, { body, sessionId })`: an `/api/control/*` call as the daemon makes
  it; bodies follow `shared/control-fixtures/daemon/`.
- `agent()`: a sandboxed Balance Agent CLI; `cli(args)` runs it, `setAiToken(token)`
  stores the fake AI's token in the sandbox's Keychain service.
- `agentApp()`: the Balance Agent app; `open()` shows its window (a second launch,
  as a user reopening it) and returns it as a page.
- `ai.answer(decision)` queues a company-AI answer; `ai.prompts` lists what it was asked.
- Throw to fail. Wait on observable end states (`locator.waitFor`), never fixed sleeps.

A journey written outside the repo imports only types (`import type … from
'/abs/path/to/sms-dashboard/scripts/verify/journey.ts'`). The driver runs with Bun
auto-install off, so a runtime import of `valibot` or `playwright-core` from the
scratchpad fails at once ("Cannot find package") instead of quietly loading a
different version. Checked-in journeys in `scripts/verify/journeys/` import normally:
`copy-verification-code.ts` (one view) and `sms-ai-reply.ts` (dashboard, daemon and
agent together).

`agentApp()` needs Electron's binary, which `bun install` does not fetch: run
`node node_modules/electron/install.js` once in `sms-dashboard/`.

## Evidence

`<out>/` survives teardown and holds `report.json` (pass/fail, every failure, notes,
evidence files, AI prompts; written even when teardown fails, which fails the run),
one screenshot per page or app window in its final state, `trace.zip`
(`bunx playwright-core show-trace <out>/trace.zip`), and each `evidence(name, data)` as
`<name>.json`. Report the verdict with the path; never claim a pass without a run.

Proof bar:

- Drive the production user path: visible controls, real routes, the real Worker and
  D1. Read state with `d1()` or `evaluate` after the user path ran; never call a
  handler or write D1 to make the feature happen.
- Cover what the change can affect: every entry point the feature file lists, desktop
  and mobile when layout is involved, and the success, cancel, error, empty and
  persistence (reload) paths.
- Prove the check can fail. For a new journey, break one expectation and watch it fail
  before trusting its pass.
- Verify side effects, not pixels alone: the row written, the clipboard, the toast.
- When a path cannot run locally, name it and what blocks it, and cover the closest
  real path. The feature files list the known ones.

## Feature map

`features/README.md` indexes one file per feature. Open the file for what you changed;
each answers the same four questions: `Sub-features`, `How to get to it (user POV)`,
`Driving it with bun run verify`, `Gotchas`. For a broad sweep, walk the README top to
bottom.

When the app changes, change its feature file in the same commit. A map that
describes behavior the app no longer has is a bug.
