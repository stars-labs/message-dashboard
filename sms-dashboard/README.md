# SMS Dashboard

Cloudflare-hosted SMS operations dashboard for the Orange Pi modem fleet.
Production is available at <https://sexy.itoken.world>.

- A Svelte 5 SPA (`client/`) served by a TypeScript Cloudflare Worker (`server/`)
  over D1 and KV. Every `/api/*` route is declared on the contract in
  `shared/api/contract/`; `openapi.json` is generated from it.
- The Balance Agent (`balance-agent/`), an Electron menu-bar app and CLI for
  carrier balance work on an operator's Mac.

Start with [AGENTS.md](AGENTS.md): development, adding a route, migrations, tests
and verification. Repository-wide rules, secrets and production boundaries are in
[../AGENTS.md](../AGENTS.md). Also:

- [Data and authorization contracts](../docs/data-contracts.md)
- [Deployment](../docs/deployment.md)
- [Auth0 tenant setup](../docs/auth0.md)
- [Balance Agent CLI](../docs/balance-agent-cli.md)

```bash
nix develop --command dev-server restart   # frontend :8080, Worker API :8787
```
