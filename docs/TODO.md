# TODO

Tracked, unassigned project work. Each item: the problem, the fix, and the
gate that unblocks it. Move an item to a plan doc when work starts.

## Back up D1 `sims` mapping to the Pi's local SQLite

**Problem.** The Orange Pi's `/var/lib/sms-daemon/messages.db` stores SMS
traffic (`messages`, `sim_storage`, `multipart_segments`) but **no
ICCID ↔ MSISDN inventory**. The only place that mapping lives is Cloudflare
D1's `sims` table. When D1 hits its free-tier daily row-read limit (happened
2026-09-02), there is no local fallback — a phone number cannot be resolved
to an ICCID, so SMS lookup by number fails entirely. The `fetch-sms` skill's
content-echo fallback only works for Chinese carriers that bill-remind; it
does not cover M1/SG SIMs.

**Fix.**
1. Export the mapping from D1 (after quota reset):
   ```bash
   bunx wrangler d1 execute sms-dashboard --remote --json \
     --command "SELECT iccid, phone_number, carrier FROM sims;"
   ```
2. Add a Pi-side table — `sim_inventory (iccid TEXT PRIMARY KEY, phone_number
   TEXT, carrier TEXT, synced_at TIMESTAMP)`. Atomic replace-all each sync;
   no backward-compat shims. D1 remains the single source of truth; the Pi
   copy is a read-only cache.
3. Wire a refresh into the daemon or a Pi cron.
4. Update the `fetch-sms` skill: number→ICCID gains a local `sim_inventory`
   lookup path ahead of the content-echo fallback.

**Gate.** D1 quota reset at 2026-09-03 00:00 UTC (08:00 Singapore). Confirm
the export query returns rows (control) before trusting the backup.

## Correct `phone_number_list.csv` and `sim-ec20-usb-location.md`

**Problem.** Two tracking files at the repo root are stale and disagree with
both live state and each other:

- `phone_number_list.csv` — static SIM inventory (95 rows: No, phone number,
  ICCID, Equipment ID/IMEI, carrier). Slowly-changing truth, but has **no
  source of truth enforcement**: if a SIM is swapped, the CSV drifts from
  D1's `sims` table with no signal. Also the only file carrying the
  ICCID↔MSISDN↔carrier mapping in the repo — the same mapping the D1 backup
  TODO above is about.
- `sim-ec20-usb-location.md` — captured **2026-06-15**, says "在线 EC20: 67 /
  CSV 库存: 95 / 成功匹配: 67." It lists a USB-path and `ttyUSB<n>` for each
  matched SIM, plus 28 SIMs "in CSV but not online." Both columns are ~3.5
  months stale: the daemon now caches 100+ modems (IDs like 344, 372), and the
  `modem_id`↔port assignments have churned repeatedly since (e.g. SIM
  `89860122801373816441` / #39 appears in the 2026-06 "offline" list but was
  live on port 42 today; that same SIM has shown up on ports 17, 22, 38, 42,
  46, 88, 170, 198, 286 across history).

The deeper issue: `modem_id` (the `ttyUSB<n>` index) is **not a stable SIM
identity** — SIMs roam between ports across reboots and USB re-enumeration
(see issue #3). Any file that records "SIM X is on port Y" is a snapshot that
goes stale on the next reboot. The 2026-06-15 file is useful as a one-time
topology map, not as a live reference.

**Fix.**
1. **Re-capture `sim-ec20-usb-location.md`** from a live `lsusb -t` +
   daemon-cache snapshot on the Pi. Match by ICCID (stable) to phone number,
   not by `modem_id`. Stamp it with the capture date and note it is a
   **point-in-time snapshot**, not a live map.
2. **Reconcile `phone_number_list.csv` against D1 `sims`** (after quota reset):
   diff ICCID sets both ways — SIMs in CSV but not D1, and in D1 but not CSV.
   Update the CSV to match D1 (D1 is the source of truth for inventory). Add a
   `last_verified` column or a sibling note recording when the reconciliation
   ran.
3. **Decide the role of each file.** The USB-location file is a snapshot; the
   CSV is the inventory. Neither should be treated as a live source for
   `modem_id` — the `fetch-sms` skill and any operator lookup must resolve
   number→ICCID (stable), not number→port (volatile). If a live port map is
   needed, it should come from the daemon's runtime cache, not a checked-in
   markdown file.
4. **Automate the reconciliation** so it doesn't fall stale again — a job that
   diffs the daemon's detected-ICCID set against D1 `sims` and flags drift.
   This is the same "expected vs detected" check that issue #3 says is
   missing today.

**Gate.** D1 quota reset at 2026-09-03 00:00 UTC (08:00 Singapore) — the
reconciliation needs to read D1. SSH to the Pi for the live `lsusb -t` +
daemon cache snapshot can run anytime (no D1 dependency).

**Control / how to verify.**
- After re-capture: the USB-location file's online count should match the
  daemon's `✅ Cached modem N with ICCID …` line count for the same boot
  session. If they differ, the snapshot was taken mid-enumeration — redo it.
- After CSV reconciliation: `SELECT COUNT(*) FROM sims;` (D1) == row count of
  `phone_number_list.csv`, and the ICCID set diff is empty. Non-empty diff is
  the list of SIMs to investigate.
