# Feature map

Behavior-level inventory of the SMS dashboard. An agent opens the file for the feature
it changed to decide what to drive and what evidence counts; a human reads it as the
regression checklist. One file per feature, the same four sections in each.

## Baseline preconditions

Every journey starts from what [`../SKILL.md`](../SKILL.md) sets up, so no feature
file repeats it:

- Signed in as `auth0|e2e-admin` with the `sms-admin` role: every permission, every
  view. A journey about a lesser role says so.
- Data is `sms-dashboard/scripts/e2e/seed.sql` and nothing else. Rows worth knowing:
  - SIMs S01 Singtel postpaid (`+6580000001`), S02 M1 prepaid (`+6580000002`), S03
    China Mobile, secondary of S01, its modem disconnected.
  - Received messages `e2e-msg-1` (code `482913`, on S01, tagged OTP), `e2e-msg-2`
    (code `7731`, S02), `e2e-msg-3` (filtered by the `PROMO` sender rule); sent message
    `e2e-msg-4` from S02.
  - A parsed balance check for S03 (CNY 25.30), a Singtel billing account with one bill
    due in 10 days, one answered inbound call on S01, daemon `orange-pi-main` online.

  Read the seed before relying on anything else.
- `desktop` is 1440×900, `mobile` is 440×900.
- Prefer role + accessible name, `aria-label`, `title` and label text, in that order.
  The UI text is Chinese; quote it exactly.
- Wait on an observable end state, never a fixed sleep.

## Safety

A run is sealed: local Worker, local D1, fake Auth0, fake AI, no daemon, no Balance
Agent unless a journey starts one against the stack. Nothing it does can send an SMS,
query a carrier or touch production. Keep it that way:

- Never point a journey, the agent or the daemon at `sexy.itoken.world` or a real
  Auth0 tenant.
- Never automate a CAPTCHA or slider. Carrier-browser human verification is an
  operator handoff, not a journey.
- Never claim a carrier-browser job, click 登录 in the Balance Agent app, or type an AI
  token into it: each reaches outside the run (see the agent files).
- Run the Balance Agent only through `agent()` / `agentApp()`, never bare: bare, it
  reads and writes the operator's own installation.

## Proof and skip reporting

The feature file defines the coverage set for a change to that feature:

- Exercise every listed entry point and sub-feature the change can affect, at both
  widths when layout is involved, through success, cancel, error, empty and reload.
- Record the action and the final state: a screenshot comes free per page; add D1 rows,
  clipboard or toast text with `evidence()`.
- When a path cannot run locally, name it and its blocker, and cover the closest real
  path. Never weaken a journey to make it pass; a missing seed precondition is a
  failure whose reason goes in that feature's `Gotchas`.

## Full sweep

Walk the index top to bottom.

## Dashboard

- [dashboard-shell](dashboard-shell.md): sign-in gate, navigation at both widths,
  status banners, daemon health, toasts, the service-worker update prompt.
- [dashboard-message-feed](dashboard-message-feed.md): the message feed: search and
  filters, verification-code copy, filtered messages, detail, refresh.
- [dashboard-send](dashboard-send.md): compose and send an SMS from a SIM; the queued
  row it writes.
- [dashboard-iccid-mappings](dashboard-iccid-mappings.md): the SIM inventory: list,
  search, edit a SIM's fields.
- [dashboard-balances](dashboard-balances.md): the Balance module: balances per SIM
  and starting a balance query.

## Balance Agent

- [agent-cli](agent-cli.md): configure, device login, status, doctor and run, in a
  sandboxed CLI.
- [agent-sms-ai-run](agent-sms-ai-run.md): a carrier menu reply turned into a skill
  job, the AI's decision, and the follow-up SMS.
- [agent-app](agent-app.md): the menu-bar app's window: status and settings.
- [agent-carrier-browser](agent-carrier-browser.md): carrier portal queries. Manual
  only past the queued job.

## Entry contract

Every feature file has these four H2s, in this order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with bun run verify`
4. `Gotchas`
