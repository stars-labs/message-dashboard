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
```

- Do **not** run `wrangler d1 migrations apply --remote` — production predates
  Wrangler migration bookkeeping. Always apply only the exact new migration file.
- After deploy: verify `https://sexy.itoken.world/api/health` and the affected workflow.

## Orange Pi Daemon

This file is the **single source of truth** for the Orange Pi host. Keep the
derived command examples in `README.md`, `docs/README.md`, and
`docs/INVENTORY-README.md` synchronized with it.

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
