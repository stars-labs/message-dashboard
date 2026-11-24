# Balance Agent CLI

`balance-agent` (`sms-dashboard/balance-agent/src/cli.ts`): the operator's terminal
installation of the Balance Agent. It signs in to the Dashboard with an Auth0 device
login, keeps its tokens in macOS Keychain, and runs the `sms-ai` and `carrier-browser`
capabilities. Docs: `docs/balance-agent-cli.md`.

## Sub-features

- configure: `configure --dashboard-url --auth0-issuer --auth0-client-id
  --auth0-audience --ai-base-url --ai-model --ai-protocol anthropic|openai --name`
  writes `$XDG_CONFIG_HOME/message-dashboard/balance-agent.json`.
- login / logout: Auth0 device flow; the refresh token goes to Keychain
  (`auth0RefreshToken`).
- credentials: `set-ai-token` (interactive Keychain prompt) / `clear-ai-token`.
- status: local only: configuration, authentication, SMS AI, browser.
- doctor: Dashboard authentication, AI connection, browser runtime; claims no job.
- run: `run [--capability sms-ai|carrier-browser|all] [--once]` registers the
  installation and claims jobs; `--once` stops after one pass.

## How to get to it (user POV)

From a terminal: `bun run cli -- <command>` in `sms-dashboard/balance-agent/`, or the
packaged `balance-agent` binary.

## Driving it with bun run verify

```ts
const cli = await agent(); // own XDG dirs and Keychain service
await cli.setAiToken(ai.token);
await cli.cli(['configure', '--dashboard-url', stack.baseUrl,
  '--auth0-issuer', `http://${stack.auth0.domain}`,
  '--auth0-client-id', stack.auth0.nativeClientId,
  '--auth0-audience', stack.auth0.audience,
  '--ai-base-url', ai.baseUrl, '--ai-model', 'fake-model', '--ai-protocol', 'anthropic']);
await cli.cli(['login']);  // "Balance Agent signed in." (the fake tenant approves at once)
await cli.cli(['status']); // "Authentication: signed in", "SMS AI: configured"
await cli.cli(['doctor', '--capability', 'sms-ai']); // "OK  Dashboard …", "OK  SMS AI: 连接成功"
await cli.cli(['run', '--capability', 'sms-ai', '--once']); // exit 0
await evidence('runner', await stack.d1('SELECT * FROM balance_runner_installations'));
// one row: auth_mode 'auth0_device', auth_subject 'auth0|e2e-admin'
```

Proof: each command's exit code and output (`{ code, stdout, stderr }`), plus the
installation row a `run` registers.

## Gotchas

- Each command is its own process: state carried between them (login → status) lives
  only in the sandbox's config file and Keychain service, which is what a real
  operator's next command reads.
- Never run the CLI outside `agent()` in a journey: unsandboxed it reads and writes the
  operator's own Keychain entries.
- Plain `http://` issuers are accepted only for localhost and 127.0.0.1
  (`shared/auth0-origin.ts`).
- `doctor`'s AI check and the `sms-ai` capability's own check ask the AI different
  questions; the fake AI answers both. A real company AI needs the VPN.
- `credentials set-ai-token` is interactive; journeys use `setAiToken` instead.
- `--capability carrier-browser` opens real carrier portals. See
  [agent-carrier-browser](agent-carrier-browser.md).
