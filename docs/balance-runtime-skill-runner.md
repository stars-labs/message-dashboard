# Balance Runtime Skill Runner

## Purpose

Carrier balance menus change and cannot always be represented by fixed response strings. The runtime skill runner lets an AI choose a read-only menu response while keeping durable state, recipients, safety validation, and auditing in the Cloudflare Worker.

The company AI endpoint is reachable only from the company VPN. Therefore the AI call runs on a user's VPN-connected computer, not on Cloudflare or the Orange Pi.

## Architecture

1. The Orange Pi sends the configured balance-query SMS.
2. The Worker correlates the carrier reply with the balance check.
3. Known deterministic routes and balance parsers run first.
4. An unresolved reply creates a durable `sim_balance_skill_jobs` task.
5. A local runner confirms VPN connectivity and claims a two-minute lease.
6. The runner sends only the balance objective, carrier reply, and extracted menu options to the company AI.
7. The Worker validates the returned structured decision again.
8. A valid menu selection queues the next SMS; a valid balance stores the metric; unsafe or uncertain decisions stop.

The AI cannot choose the SIM or recipient. The Worker always uses the SIM already attached to the check and the destination in `sim_balance_profiles`.

## Safety Rules

- Fixed rules remain the preferred fast path.
- AI confidence must meet the configured threshold.
- A reply must exactly match a numeric option present in the carrier SMS.
- Recharge, payment, purchase, subscription, cancellation, activation, and plan changes are forbidden.
- A parsed balance needs an allowlisted currency and evidence copied exactly from the carrier SMS.
- Every proposal and applied outcome is stored in `sim_balance_skill_decisions`.
- VPN or provider failures release the lease and leave the task pending.

## Local Configuration

Edit the encrypted development secrets:

```sh
sops secrets/dev-vars.yaml
```

Required runner variables:

```yaml
API_KEY: existing-dashboard-api-key
BALANCE_AI_TOKEN: company-ai-token
BALANCE_AI_MODEL: claude-sonnet-4-5
```

Optional variables:

```yaml
BALANCE_AI_BASE_URL: https://aihub.huobiapps.com/api/cc
BALANCE_AI_PROTOCOL: anthropic
SMS_API_URL: https://sexy.qzz.io
BALANCE_SKILL_RUNNER_ID: operator-laptop
```

Run while connected to the company VPN:

```sh
nix develop --command balance-skill-runner
```

For normal operation, start one background runner and leave it running:

```sh
nix develop --command balance-skill-service start
nix develop --command balance-skill-service status
```

Operations:

```sh
nix develop --command balance-skill-service logs
nix develop --command balance-skill-service restart
nix develop --command balance-skill-service stop
```

The runner itself holds a process lock, so foreground, `--once`, and background
invocations cannot overlap. Its PID, lock, and service log are stored under
`~/.local/state/message-dashboard/` by default.

Use `--once` for a single claim attempt:

```sh
nix develop --command balance-skill-runner --once
```

Validate VPN connectivity, token, protocol, and model without claiming a task:

```sh
nix develop --command balance-skill-runner --check
```

The `/api/cc` gateway uses the Anthropic Messages protocol. Its client-facing
`claude-sonnet-4-5` alias is mapped by the company gateway to the company GPT 5.5
deployment; `gpt-5.5` is not accepted directly as the request model.

The company AI token is injected by `sops exec-env`, remains on the local computer, and is never sent to the Worker or Orange Pi.

## Deployment Note

The production database predates Wrangler migration tracking, so
`wrangler d1 migrations apply --remote` reports historical migrations as pending
and must not be used. Migration `042` has already been applied. For future changes,
inspect the remote schema and apply only the exact new migration file before
deploying the Worker:

```sh
cd sms-dashboard
CLOUDFLARE_ACCOUNT_ID=793e3286eaca411bf1eebaf4b8c7051e \
  bunx wrangler d1 execute sms-dashboard --remote \
  --file=migrations/NNN_name.sql
CLOUDFLARE_ACCOUNT_ID=793e3286eaca411bf1eebaf4b8c7051e bun run deploy
```
