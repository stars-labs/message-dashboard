# Deployment Procedures

## Cloudflare Worker + Frontend

```bash
cd sms-dashboard

# 1. Confirm identity
bunx wrangler whoami   # must be @bitgc.io, account 793e3286eaca411bf1eebaf4b8c7051e

# 2. Apply any new D1 migration (if needed)
bunx wrangler d1 execute sms-dashboard --remote --file=migrations/NNN_name.sql

# 3. Deploy
bun run deploy

# 4. After a migration: regenerate the baseline (the headers of
#    migrations/schema.sql and reference-data.sql give the commands; set
#    `through` to NNN), then confirm it matches production and commit it
bun run check:schema-drift
```

- Do **not** run `wrangler d1 migrations apply --remote` — production predates
  Wrangler migration bookkeeping. Always apply only the exact new migration file.
- `bun run check` fails once main has a migration newer than `schema.sql`'s
  `through`, so step 4 cannot be skipped for long. `check:schema-drift` reads
  production (two `d1 export` calls, which briefly hold other D1 requests).
- After deploy: verify `https://sexy.itoken.world/api/health` and the affected workflow.

## D1 Backup and Account Move

```bash
cd sms-dashboard
bunx wrangler d1 export sms-dashboard --remote --output="$BACKUP_DIR/sms-dashboard.sql"
```

Keep the dump outside the repository: it holds phone numbers and message text.
A dump restores only into an empty database; never replay it over production.

To move the Worker to another Cloudflare account:

1. Export production as above.
2. `bunx wrangler d1 create sms-dashboard` and `bunx wrangler kv namespace create SESSIONS`;
   put the new `account_id`, `database_id` and KV `id` in `wrangler.toml`.
3. `bunx wrangler d1 execute sms-dashboard --remote --file="$BACKUP_DIR/sms-dashboard.sql"`.
4. `bunx wrangler secret put <NAME>` for each secret in `server/secrets-env.d.ts`,
   except `USE_AUTH0_ROLES`, which exists only so tests can prove it is ignored.
5. `bun run deploy`. The first deploy creates the `CALL_STATE` Durable Object from
   the `[[migrations]]` block in `wrangler.toml`.
6. Add the new hostname to the Auth0 application's callback, logout and web-origin
   URLs ([Auth0 setup](auth0.md)).

## Orange Pi Daemon

This file is the **single source of truth** for the Orange Pi host: other docs
link here rather than repeat its address or commands.

Target: `root@10.171.150.102` (fixed LAN address, NixOS aarch64).

- **LAN access**: before ping or SSH, confirm the operator's current network/location
  and that `10.171.150.102` is reachable from it.

CI builds the Pi system for every push to `main` (job "Orange Pi system",
arm64 runner) and pushes it to Cachix. Deploy by downloading that build:

```bash
# 1. Push to main and wait for CI to go green. The job summary of
#    "Orange Pi system" ends with the exact line for step 2.
# 2. On the Pi, as root (survives a dropped SSH session):
pi-deploy /nix/store/<hash>-nixos-system-orange-pi-sms-<version>
```

`pi-deploy` substitutes the closure from `xiongchenyu6.cachix.org` and
`cache.nixos.org`, sets the system profile and switches; it builds locally
only when a path is in neither cache. To try an uncommitted change without
CI, evaluate here and let the Pi build it:

```bash
drv=$(nix eval --raw .#nixosConfigurations.orange-pi.config.system.build.toplevel.drvPath)
nix copy --derivation --to ssh://root@10.171.150.102 "$drv"
ssh root@10.171.150.102 pi-deploy "$drv"
```

After deploy: confirm `sms-daemon` is active, check `journalctl -u sms-daemon -f`
for errors, and wait for a fresh production heartbeat.

## Balance Agent Release

```bash
# From repo root — builds .app, zips, emits SHA-256:
nix run .#release-balance-agent -- <version>
# Artifacts: sms-dashboard/balance-agent/release/<version>/
```

- Publish artifacts as a private GitHub prerelease. Users authenticate to download.
- Ad-hoc signed only (not Developer ID / notarized) — internal team use.
- No silent auto-updates.
