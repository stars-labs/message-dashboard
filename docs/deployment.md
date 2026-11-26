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
- A migration that rebuilds tables (`084` rebuilds `messages` and nine other
  tables) is not documented as atomic when run with `d1 execute --file`. Before
  applying one, record a Time Travel bookmark, and keep it until the counts match:

  ```bash
  bunx wrangler d1 time-travel info sms-dashboard          # note the bookmark
  bunx wrangler d1 execute sms-dashboard --remote --file=migrations/084_balance_batches.sql
  bunx wrangler d1 execute sms-dashboard --remote \
    --command "SELECT (SELECT COUNT(*) FROM messages) m, (SELECT COUNT(*) FROM sim_balance_checks) c, (SELECT COUNT(*) FROM sim_balance_metrics) x"
  # Counts differ from before, or the file failed part-way:
  bunx wrangler d1 time-travel restore sms-dashboard --bookmark=<bookmark>
  ```

  Take the same counts before applying. Apply the migration before deploying the
  Worker that needs it.

### Free-plan limits

Keep this section accessible outside the dashboard. The Worker serves the dashboard itself.
The [production Workers Plans page](https://dash.cloudflare.com/793e3286eaca411bf1eebaf4b8c7051e/workers/plans)
is the upgrade entry point for the Cloudflare limits below.

| Signal | Impact and recovery |
|---|---|
| `D1_QUOTA_EXCEEDED` | The daily row read or write allowance resets at 00:00 UTC (08:00 Singapore time). Upgrade to Workers Paid for earlier recovery, then click **检查是否恢复** in the dashboard. A newer daemon heartbeat confirms that D1 writes are working again. For urgent SMS access, see [reading from the Pi's local store](../.claude/skills/fetch-sms/SKILL.md). [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 storage full | Daily reset does not free storage. Check the database size, apply the retention policy, or upgrade if the free-plan storage cap is the cause. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Cloudflare error `1027` | The Workers daily request allowance is exhausted. The dashboard may be unreachable. Wait until 00:00 UTC or upgrade to Workers Paid. [Workers request limits](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) |
| Workers KV daily allowance exhausted | Session reads or writes can fail. Check KV usage, then wait until 00:00 UTC or upgrade to Workers Paid. The same-key write limit also applies on Paid. [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) and [limits](https://developers.cloudflare.com/kv/platform/limits/) |
| Durable Objects daily allowance exhausted | Live call state can be unavailable. Check `CALL_STATE` usage, then wait until 00:00 UTC or upgrade to Workers Paid. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Auth0 Management API `429` | Check the upstream retry time and retry the affected admin operation after it resets. If limits are repeatedly reached, check which tenant and API limit applies before changing plans. [Auth0 rate limit policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy) |
| Email Sending rejects an unverified destination | Verify the destination, or upgrade to Workers Paid if sending to arbitrary addresses is required. [Destination address rules](https://developers.cloudflare.com/email-service/configuration/destination-addresses/) |

### Alert emails

The five-minute cron (`server/utils/alerts.ts`) emails when the daemon has sent no
heartbeat for 20 minutes, and when the check itself fails. It emails again every 6
hours while the daemon stays silent, and once more when it reports again. State lives
in the `alert_state` table, written only when an alert opens, is emailed or clears,
and always before the email goes out. When D1 refuses that write, the check fails
instead: it emails once per 6 hours (deduplicated in KV), and for a D1 quota error
the email names the quota and its reset time, because a daemon whose heartbeats
cannot be recorded looks silent from D1. Offline SIMs send no email by decision: they
are not urgent, and the dashboard shows them.

Where its configuration lives:

- **Sender**: `alerts.itoken.world`, onboarded in the dashboard under Compute → Email
  Service → Email Sending, which created the records on `cf-bounce.alerts.itoken.world`.
  The `EMAIL` binding in `wrangler.toml` may only send as `noreply@alerts.itoken.world`.
- **Recipients**: on the Workers Free plan only verified destination addresses receive
  mail. Add an address under Email Routing → Destination addresses, have its owner
  click the verification link, then list it in the secret:
  `bunx wrangler secret put ALERT_RECIPIENTS` (comma-separated). Addresses stay out of
  the repository.
- Without `ALERT_RECIPIENTS` an alert stays open and unsent, and goes out on the first
  run after the secret is set.

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

### Pi secrets

`nixos-config/secrets/orange-pi.yaml` is SOPS-encrypted. sops-nix decrypts it on
the Pi at activation with the Pi's SSH host key (`/etc/ssh/ssh_host_ed25519_key`,
the `orangepi` age recipient in `.sops.yaml`); people are PGP recipients. The keys
it must hold are the `sops.secrets` entries in `flake.nix` and `nixos-config/`.

Opening the file decrypts it, so it needs the operator's go-ahead each time
([AGENTS.md](../AGENTS.md)). From the dev shell:

```bash
sops nixos-config/secrets/orange-pi.yaml               # edit; re-encrypts on save
sops updatekeys nixos-config/secrets/orange-pi.yaml    # after changing recipients in .sops.yaml
nix shell nixpkgs#ssh-to-age -c ssh-to-age < ssh_host_ed25519_key.pub   # a new Pi's age recipient
```

## Balance Agent Release

The version is `sms-dashboard/balance-agent/package.json`'s, and nothing else: the app
reports it, the release is tagged with it, and the Worker announces it.

```bash
# 1. Bump "version" in sms-dashboard/balance-agent/package.json; merge to main.
# 2. From repo root, on that commit of main (needs `gh auth login`):
nix run .#release-balance-agent
# 3. Deploy the Worker from the same commit (Cloudflare Worker + Frontend above).
```

- The command refuses uncommitted changes, a commit not on `origin/main`, and a
  version already released. It runs `bun run check`, builds and zips the app with its
  SHA-256 into `sms-dashboard/balance-agent/release/<version>/`, and publishes them as
  the private prerelease `balance-agent-v<version>`. Users sign in to GitHub to
  download.
- Every heartbeat answer carries the version the deployed Worker was built with.
  An app older than it shows 有新版本 x.y.z · 打开下载页 in its menu, which opens the
  release page. Release before deploying, or that link leads to a release that does
  not exist yet.
- Ad-hoc signed only (not Developer ID / notarized) — internal team use.
- No silent auto-updates.
