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

Target: `root@10.40.0.51` (office LAN, NixOS aarch64).

- **Office network**: SSH works directly — test with `ping -c2 10.40.0.51` first.

```bash
# From repo root — run check-daemon first:
check-daemon

nix run nixpkgs#nixos-rebuild -- switch --flake .#orange-pi \
  --target-host root@10.40.0.51 \
  --build-host root@10.40.0.51 \
  --use-substitutes --impure
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
