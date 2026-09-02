---
name: fetch-sms
description: Fetch recent SMS for a SIM by phone number, modem port index, or ICCID. Queries the Orange Pi's local SQLite store directly over SSH — bypasses the Cloudflare D1 API (useful when D1 is over its daily row-read quota or the Worker upload is failing). Load before answering "what SMS did X receive" questions about the modem farm.
---

# Fetch SMS — Orange Pi local store

Read SMS directly from the Orange Pi daemon's SQLite database over SSH.
This is the **local** source of truth; the Cloudflare D1 `messages` table is a
synced copy that can lag or fail (D1 free-tier row-read limit, 500s on upload).

## Target

- Host: `root@10.40.0.51` (Orange Pi, DHCP after 2026-08 office relocation).
  The old static `10.171.150.102` is **dead** — do not use it.
  `ping -c2 10.40.0.51` first if unsure; if that IP stops resolving, the Pi may
  have a new DHCP lease — check `docs/deployment.md` and recent nixos commits.
- DB: `/var/lib/sms-daemon/messages.db` (SQLite, WAL mode).
- The Pi has **no `sqlite3` binary**. Run it via an ephemeral nix shell:
  `nix run --extra-experimental-features "nix-command flakes" nixpkgs#sqlite -- …`
  (first run fetches ~1 MB; subsequent runs are instant). This follows the
  Nix-first rule — never install sqlite3 imperatively.

## Input → resolve to ICCID (the stable key)

`messages.phone_number` is the **sender**, not the SIM's own number. The stable
identity is `phone_iccid`. Accept any of three inputs and resolve:

| Input | How to resolve to `phone_iccid` |
| ----- | ------------------------------- |
| **ICCID** (`89…`, 19-20 digits) | Use directly — it IS the key. No lookup. |
| **Phone number** (`185…`, 11 digits, the SIM's own MSISDN) | Resolve per below — D1 first, content-echo fallback. |
| **Modem port index** (`"42"`, `"39"`) | **Unstable** — see caveat. Queryable directly but answers "whatever SIM is in that port right now", not a fixed number. |

### Phone number → ICCID

1. **D1 lookup (preferred):** from `sms-dashboard/` run
   ```bash
   bunx wrangler d1 execute sms-dashboard --remote --json --command \
     "SELECT iccid, phone_number, carrier FROM sims WHERE phone_number LIKE '%<number>%';"
   ```
   If this returns `exceeded D1's free tier daily row read limit` (common late in
   a UTC day), fall through to step 2 — do **not** retry D1.
2. **Content-echo fallback (no D1 needed):** Chinese carriers bill-remind by
   echoing the subscriber's own number in the body. Search the local DB:
   ```sql
   SELECT DISTINCT phone_iccid FROM messages WHERE content LIKE '%<number>%';
   ```
   If multiple ICCIDs surface, cross-check: the right one has many matches and
   bill-reminder senders like `10010` / `106…`. A single spurious hit (someone
   typing the number into a form once) is the wrong SIM.
3. If neither resolves, ask the user for the ICCID.

### Modem port index caveat

`modem_id` is the `/dev/ttyUSB<n>` index — a **port**, not a SIM. SIMs roam
between ports across reboots and re-seating. Querying by `modem_id='39'` answers
"whatever SIM is currently in port 39", which is **not** a fixed phone number.
Only use this axis if the user explicitly means the physical port; otherwise
resolve the number → ICCID and query by `phone_iccid`.

## Query

Always query by `phone_iccid`. Pass SQL via **stdin heredoc** (single-quoted
`<<'SQL'`) — double-quoted `LIKE "%…%"` breaks under shell quoting on the Pi.

```bash
ssh -o ConnectTimeout=10 -o BatchMode=yes root@10.40.0.51 \
  'nix run --extra-experimental-features "nix-command flakes" nixpkgs#sqlite -- \
   /var/lib/sms-daemon/messages.db' <<'SQL' 2>&1 | tail -120
.mode line
SELECT id, modem_id, phone_number AS sender, timestamp,
       datetime(created_at) AS stored_at, status, content
FROM messages
WHERE phone_iccid = '<iccid>'
ORDER BY timestamp DESC
LIMIT 8;
SQL
```

### Status column

- `uploaded` — synced to D1 successfully.
- `failed` — saved locally; the D1 upload failed (commonly D1 quota or a 500).
  The SMS **is in the local DB**; "failed" only describes the sync, not receipt.
- `uploading` — in-flight; treat as saved.

Do not treat `failed` as missing — always report the message.

## Verify the query can return rows (control)

An empty result is only meaningful if the query path works. If the first query
returns nothing, run a control before concluding "no SMS":

```sql
.mode column
.headers on
SELECT COUNT(*) AS total, MAX(datetime(created_at)) AS newest FROM messages;
SELECT id, phone_iccid, phone_number, timestamp, status
FROM messages ORDER BY id DESC LIMIT 5;
```

If `total` is 0 or the recent rows don't exist, the DB is stale or the daemon
isn't writing — check `systemctl is-active sms-daemon`. If `total` > 0 but the
ICCID query is empty, the ICCID is wrong — re-resolve.

## Output

Present a compact table: time (UTC and Beijing = UTC+8), sender, body. Lead
with the newest. Flag any verification-code SMS (they expire in 5 min — note
the time elapsed since `timestamp`). If the user asked for "new since last
check", note the `id` of the prior fetch so they can see the delta.

## Schema reference (messages table)

```
id              INTEGER PRIMARY KEY
phone_iccid     TEXT   -- the SIM identity; query by this
phone_number    TEXT   -- the SENDER, not the SIM's own number
content         TEXT
timestamp       TEXT   -- ISO 8601 UTC, e.g. 2026-09-02T06:24:38.000Z
direction       TEXT   -- 'received' (inbound) or 'sent'
modem_id        TEXT   -- ttyUSB port index, NOT a stable SIM key
sms_path        TEXT
status          TEXT   -- pending|uploading|uploaded|failed
attempts        INTEGER
created_at      TIMESTAMP
uploaded_at     TIMESTAMP
deleted_at      TIMESTAMP
error           TEXT
```
UNIQUE constraint: `(phone_iccid, timestamp, content)` — dedup is built in.

## Never

- Use the old IP `10.171.150.102`.
- Install `sqlite3` on the Pi imperatively — use the nix one-shot.
- Treat `modem_id` as a stable SIM identity or `phone_number` as the SIM's own number.
- Retry D1 after a quota error — fall through to the content-echo fallback.
- Treat `status='failed'` as "not received" — it means "not synced to D1".
