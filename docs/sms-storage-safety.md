# SMS Storage Safety

Rules for any daemon change that reads or deletes SMS on the modem or SIM.

## Why

An incoming SMS lands in the EC20's `ME` storage or the SIM's `SM` storage. Both
are small. When one fills, the carrier stops delivering new SMS while the Pi, D1
and the dashboard all look healthy; a modem that dies with unread SMS in `ME` loses
them. So physical storage is a short-lived ingress buffer, the Pi's SQLite store
is the first durable copy, and D1 the long-term one.

## How the reader treats storage

- `ME` and `SM` are scanned separately. On the EC20, `MT` is an alias for `ME`, not
  the union of `ME` and `SM`.
- A message is deleted from its exact `storage:index` (`AT+CMGD=<index>`) only
  after it is committed to SQLite. SQLite, not D1, is the durability boundary, so a
  Cloudflare outage never holds SMS in hardware.
- A message the store already holds (same SIM and content within ten seconds) has
  its hardware copy deleted too; before 3e7aa1c, copies stranded by a reset were
  re-read every scan.
- Parts of a multipart SMS stay in hardware until every part arrives. A group with no
  new part for 24 hours is delivered as `[不完整 n/m]` and then
  deleted the same way (4faab80).

## Invariants

1. **Persist before delete.** No SMS, segment or raw PDU leaves `ME` or `SM` before
   a durable local commit.
2. **Exact location only.** Delete the recorded storage and index; never infer the
   active store, never bulk-delete, never `AT+CMGD=1,4`.
3. **Deduplication is not deletion.** A message already stored locally may still
   need its hardware copy deleted.
4. **Index reuse.** A retried delete must revalidate that the index still holds the
   same message; a newer SMS can reuse it.
5. **Receiving and sending first.** Telemetry and cleanup yield to them. There is
   no shared per-modem lock across read, send, diagnostics, store selection and
   delete yet, so do not add commands that switch `CPMS` outside the scan.
6. **Fail closed.** Ambiguous storage, index, parse result or ICCID means no delete.
7. **No silent loss.** Content that cannot be parsed is kept as raw input before
   any policy may remove it from hardware.

## Before shipping such a change

The tests must cover: Cloudflare unavailable, daemon restart, modem reconnect,
SIM swap (stop every pending delete for the old ICCID), a failed `AT+CMGD`, index
reuse, one store readable and the other failing, a missing multipart part, an
unparseable PDU, and SQLite write failure or a full disk (no hardware delete).

A new field in the daemon's health payload ships Worker first (accepting old and
new payloads), then the frontend (treating it as optional), then the daemon.

## Evidence

`orange-pi-daemon/scripts/collect-storage-baseline.sh` collects read-only
aggregate counts on the Pi. Sanitized records go in `docs/evidence/sms-storage/`
(the 2026-08-14 baseline is there), never SMS bodies, phone numbers or raw PDUs.
