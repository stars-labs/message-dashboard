# Known Issues

## Database

### 1. Duplicate SIMs from ICCID trailing `F` padding
**Status**: Open
**Impact**: 121 SIM records instead of ~97 (24 logical duplicates)

ICCID standard pads to 20 digits with `F`. The daemon creates two records for the same physical SIM — one with and one without the trailing `F`.

**23 duplicate pairs found** (queried 2026-03-05):

| ICCID (without F) | ICCID (with F) | Equipment ID | Updated (no F) | Updated (with F) |
|---|---|---|---|---|
| `8965030124051507851` | `8965030124051507851F` | `865827078906716` | 2026-03-04 07:59 | 2026-03-04 09:40 |
| `8965012306052989699` | `8965012306052989699F` | `865827078941325` | 2026-02-12 09:38 | 2026-03-05 05:33 |
| `8965012306052989731` | `8965012306052989731F` | `865827078973013` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052989657` | `8965012306052989657F` | `865827078973062` | 2026-03-04 09:44 | 2026-03-04 09:44 |
| `8965012306052577791` | `8965012306052577791F` | `865827078989076` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965030124051507901` | `8965030124051507901F` | `865827079000667` | 2025-12-29 09:43 | 2025-12-31 04:11 |
| `8965012211290057038` | `8965012211290057038F` | `865827079001152` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052989665` | `8965012306052989665F` | `865827079030235` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052576256` | `8965012306052576256F` | `865827079030318` | 2025-12-29 07:32 | 2026-03-05 05:33 |
| `8965030124051507893` | `8965030124051507893F` | `865827079030748` | 2025-12-31 04:08 | 2025-12-31 04:11 |
| `8965030124051507919` | `8965030124051507919F` | `865827079067088` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965030124051507927` | `8965030124051507927F` | `865827079072385` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052373985` | `8965012306052373985F` | `865827079072971` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965012211290056949` | `8965012211290056949F` | `865827079073110` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012211290057046` | `8965012211290057046F` | `865827079073193` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052580191` | `8965012306052580191F` | `865827079073235` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052989707` | `8965012306052989707F` | `865827079073318` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012211290057004` | `8965012211290057004F` | `865827079073391` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052579276` | `8965012306052579276F` | `865827079073417` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052989673` | `8965012306052989673F` | `865827079073458` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965012306052989715` | `8965012306052989715F` | `865827079073474` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965012306052989681` | `8965012306052989681F` | `865827079073482` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052989640` | `8965012306052989640F` | `865827079088241` | 2026-03-04 09:49 | 2026-03-05 05:33 |

**Root cause**: Daemon reads ICCID differently at different times (with/without BCD padding). Per ITU-T E.118, the ICCID is max 19-20 digits. The trailing `F` is a **storage-level filler** in packed BCD (10 octets), not part of the actual ICCID. The canonical form is **without** the `F`.

**Root cause in code** — 3 ICCID entry points, none strip trailing `F`:

1. **`at_modem.rs:340-351`** — `parse_iccid()`: Returns raw ICCID with `F`. Comment acknowledges padding but doesn't strip it. Test at line 1036 confirms `F` is preserved.
2. **`native_dbus.rs:271`** — `get_sim_iccid()`: Returns `sim_proxy.sim_identifier()` from ModemManager D-Bus. ModemManager usually strips `F` but not guaranteed.
3. **`dbus_client.rs:319`** — `get_sim_iccid_busctl()`: Parses raw busctl output, no normalization.

The same modem returns ICCID **with `F`** via AT commands and **without `F`** via D-Bus at different times → creates both records.

**Fix status**:
1. **Daemon fix**: Done — `at_modem.rs:parse_iccid()`, `native_dbus.rs:get_sim_iccid()`, `dbus_client.rs:get_sim_iccid_busctl()` all strip trailing `F`
2. **Tests**: Done — `at_modem.rs` tests updated to expect stripped ICCIDs (29/29 passing)
3. **DB cleanup**: Migration written at `sms-dashboard/migrations/014_cleanup_iccid_duplicates.sql` — see [Release Guide](#release-guide) below

### 2. Modem `865827078940772` has 6 stale SIM assignments
**Status**: Open
**Impact**: 6 SIMs marked active on one modem, all with no phone number

```
89852122109190418053  active  2025-12-31 03:59:15
89860122801362457439  active  2025-12-29 08:02:23
89860122801362457363  active  2025-12-29 08:12:54
89860122801362457371  active  2025-12-29 08:22:56
89860122801362457355  active  2025-12-31 03:30:51
89860122801362457447  active  2025-12-30 06:37:22
```

These are different ICCIDs (not the trailing `F` issue). Likely SIM cards that were physically swapped through this modem slot but never deactivated.

**Root cause**: SIM swap detection trigger may not have been active when these were inserted, or the daemon re-assigned without clearing old records.
**Fix needed**:
1. DB cleanup: keep only the most recently updated SIM per modem, mark the rest inactive
2. Investigate if daemon properly clears old SIM assignments on swap

---

## Release Guide

### Deploy order

The daemon fix and DB cleanup must be deployed in the right order to avoid re-creating duplicates.

1. **Apply DB migration** (clean up existing duplicates)
2. **Deploy daemon** (prevent new duplicates from being created)

If you deploy the daemon first, it will start writing canonical ICCIDs while the DB still has F-suffixed records — the old duplicates remain but no new ones appear. If you clean up the DB first but deploy the daemon later, the old daemon could re-create F-suffixed records before the new daemon takes over. Either order works, but **DB first → daemon second** is cleaner.

### Step 0: Local testing (do this first)

Test the migration on a local copy of production data before touching the real DB.

```bash
# 0a. Export production D1 to SQL dump
npx wrangler d1 export sms-dashboard --remote --output=sms-dashboard/dump.sql

# 0b. Import into local D1
npx wrangler d1 execute sms-dashboard --local --file=sms-dashboard/dump.sql

# 0c. Verify local copy has the duplicates (should return 23)
npx wrangler d1 execute sms-dashboard --local \
  --command="SELECT COUNT(*) as f_suffixed FROM sims WHERE iccid LIKE '%F' AND LENGTH(iccid) = 20"

# 0d. Run migration locally
npx wrangler d1 execute sms-dashboard --local \
  --file=sms-dashboard/migrations/014_cleanup_iccid_duplicates.sql

# 0e. Verify: SIM count should drop from 121 to ~98
npx wrangler d1 execute sms-dashboard --local \
  --command="SELECT COUNT(*) as total_sims FROM sims"

# 0f. Verify: no F-suffixed duplicates remain
npx wrangler d1 execute sms-dashboard --local \
  --command="SELECT COUNT(*) as remaining_f FROM sims WHERE iccid LIKE '%F' AND LENGTH(iccid) = 20 AND SUBSTR(iccid, 1, LENGTH(iccid) - 1) IN (SELECT iccid FROM sims WHERE iccid NOT LIKE '%F')"

# 0g. Spot-check: messages should reference canonical ICCIDs
npx wrangler d1 execute sms-dashboard --local \
  --command="SELECT COUNT(*) as f_messages FROM messages WHERE phone_iccid LIKE '%F' AND LENGTH(phone_iccid) = 20"
```

All wrangler commands run from the `sms-dashboard/` directory (where `wrangler.toml` lives). `dump.sql` is gitignored.

### Step 1: DB migration — ICCID duplicate cleanup (production)

**Migration file**: `sms-dashboard/migrations/014_cleanup_iccid_duplicates.sql`

```bash
# 1a. Pre-flight: verify duplicates exist (should return 23)
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT COUNT(*) as f_suffixed FROM sims WHERE iccid LIKE '%F' AND LENGTH(iccid) = 20"

# 1b. Optional: check which messages will be affected
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT COUNT(*) as affected_messages FROM messages WHERE phone_iccid LIKE '%F' AND LENGTH(phone_iccid) = 20"

# 1c. Apply migration
npx wrangler d1 execute sms-dashboard --remote \
  --file=sms-dashboard/migrations/014_cleanup_iccid_duplicates.sql

# 1d. Verify: SIM count should drop from 121 to ~98
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT COUNT(*) as total_sims FROM sims"

# 1e. Verify: no F-suffixed duplicates remain
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT COUNT(*) as remaining_f FROM sims WHERE iccid LIKE '%F' AND LENGTH(iccid) = 20 AND SUBSTR(iccid, 1, LENGTH(iccid) - 1) IN (SELECT iccid FROM sims WHERE iccid NOT LIKE '%F')"
```

**What the migration does** (6 steps):
1. Repoints `messages.phone_iccid` from `...F` → canonical
2. Repoints `modem_sim_history.sim_iccid` from `...F` → canonical
3. Repoints `iccid_mappings.iccid` from `...F` → canonical
4. Merges non-null fields from F-version into canonical SIM (via `COALESCE`)
5. Deletes the 23 F-suffixed duplicate SIM records
6. Records migration as schema version 14

**Rollback**: Not provided — this is a data cleanup. If something goes wrong, restore from D1's automatic backups via the Cloudflare dashboard (Settings → Backups).

### Step 2: Deploy daemon with ICCID fix

```bash
# On NixOS (Orange Pi):
cd /path/to/message-dashboard
nixos-rebuild switch --flake .#orange-pi \
  --target-host root@10.171.150.102 \
  --build-host root@10.171.150.102 \
  --use-substitutes --impure

# Or manually build and deploy:
cd orange-pi-daemon
cargo build --release --target aarch64-unknown-linux-gnu
scp target/aarch64-unknown-linux-gnu/release/orange-pi-daemon-rust root@10.171.150.102:/usr/local/bin/
ssh root@10.171.150.102 systemctl restart sms-daemon
```

### Step 3: Verify

```bash
# Check daemon logs for ICCID values (should not end in F)
ssh root@10.171.150.102 journalctl -u sms-daemon --since '5 min ago' | grep -i iccid

# Check DB for any new F-suffixed records (should return 0)
npx wrangler d1 execute sms-dashboard --remote \
  --command="SELECT COUNT(*) FROM sims WHERE iccid LIKE '%F' AND LENGTH(iccid) = 20"
```
