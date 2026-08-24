# Balance Agent CLI

## Purpose

The Balance Agent CLI is the authenticated developer and diagnostic interface for
both local balance capabilities:

- `sms-ai` evaluates unresolved, read-only carrier menus through the company AI
  endpoint while the workstation is connected to the company VPN.
- `carrier-browser` opens a visible Chrome session, uses an SMS one-time password,
  pauses for official-site human verification when required, and reads normalized
  carrier metrics. China Unicom returns CNY balance; M1 prepaid returns SGD balance
  and account expiry.

The CLI and Electron application use the same Auth0 session, presence, serial
scheduler, and capability modules. The retired API-key scripts cannot claim
Dashboard-created work because migration `057` binds that work to the requesting
Auth0 subject.

## Trust Boundaries

- Auth0 refresh tokens and company AI tokens are stored in macOS Keychain.
- Secret values are never accepted as command-line arguments or written to the
  non-secret JSON configuration file.
- The company AI token and carrier browser cookies never go to Cloudflare, D1, or
  the Orange Pi.
- Cloudflare owns scheduling, job leases, OTP correlation, deterministic decision
  validation, audit records, and normalized balance metrics.
- Browser profiles are temporary. Human verification remains a visible operator
  handoff and is never bypassed.

The first CLI implementation supports macOS because that is the supported Balance
Agent platform. The Electron application remains the normal operator interface;
the CLI is intended for development, diagnostics, and foreground workstation use.

## Setup

Enter the Nix development shell or run the command through the flake app:

```bash
nix develop
balance-agent --help

# Equivalent from the repository checkout:
nix run .#balance-agent-cli -- --help
```

Save the public Dashboard, Auth0 native-client, and AI endpoint settings. Use the
same non-secret values configured for the desktop Balance Agent:

```bash
balance-agent configure \
  --dashboard-url https://sexy.qzz.io \
  --auth0-issuer https://AUTH0_TENANT \
  --auth0-client-id NATIVE_CLIENT_ID \
  --auth0-audience DASHBOARD_API_AUDIENCE \
  --ai-base-url COMPANY_AI_URL \
  --ai-model COMPANY_AI_MODEL \
  --ai-protocol anthropic \
  --name "Operator Mac"
```

Store the AI token through the secure Keychain prompt, then complete Auth0 Device
Authorization Flow in a browser:

```bash
balance-agent credentials set-ai-token
balance-agent login
balance-agent status
```

Non-secret settings are stored at
`$XDG_CONFIG_HOME/message-dashboard/balance-agent.json`, falling back to
`~/.config/message-dashboard/balance-agent.json`. The CLI Keychain entries are a
separate installation from the Electron application's encrypted credential file.

## Diagnostics and Operation

`doctor` checks Dashboard authentication, the selected local capabilities, and
their runtime prerequisites without claiming a balance job:

```bash
balance-agent doctor
balance-agent doctor --capability sms-ai
balance-agent doctor --capability carrier-browser
```

`run` starts independent concurrency-one loops. A browser job waiting for a slider
or image challenge does not block SMS AI work:

```bash
balance-agent run
balance-agent run --capability sms-ai
balance-agent run --capability carrier-browser
```

Use `--once` for a deterministic diagnostic claim attempt. With `all`, each
capability may claim at most one job:

```bash
balance-agent run --once
balance-agent run --capability sms-ai --once
balance-agent run --capability carrier-browser --once
```

`SIGINT` and `SIGTERM` stop both loops, release local browser resources, and send a
final stopping heartbeat. One PID lock at
`$XDG_STATE_HOME/message-dashboard/balance-agent-cli.lock`, falling back to
`~/.local/state/message-dashboard/balance-agent-cli.lock`, prevents overlapping
CLI processes. There is deliberately no background service wrapper in the minimal
CLI; use the Electron login-item support for normal persistent operation.

## Capability Safety

For SMS AI work, deterministic routes run before AI. The Worker still requires an
exact menu option, an allowlisted balance currency, sufficient confidence, and
evidence copied from the carrier reply. Recharge, payment, purchase,
subscription, cancellation, activation, and plan changes remain forbidden.

For browser work, only one OTP request is allowed per task. The Worker correlates
the received message by task ICCID, allowlisted sender, request time, and semantic
random-password context. The browser submits only the verified account, CNY
balance, and parser metadata.

## Sign-out and Rollback

```bash
balance-agent logout
balance-agent credentials clear-ai-token
```

Sign-out removes the local Auth0 refresh token. Removing the AI token disables
only the `sms-ai` capability. To stop new Unicom browser work at the product level,
disable the affected carrier browser profile; existing audit and balance records
remain readable.
