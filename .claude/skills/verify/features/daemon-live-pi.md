# Daemon on the Orange Pi (read-only, on request only)

The only place the real daemon runs: NixOS on the Orange Pi, `sms-daemon.service`, with
100+ EC20 modems. This file is not part of any sweep. Use it only when the user asks for
a check on the live Pi, and only to read.

## Sub-features

- service health: `systemctl status sms-daemon`, `journalctl -u sms-daemon`.
- local SMS store: `/var/lib/sms-daemon/messages.db` (SQLite, WAL), the source of truth
  the D1 `messages` table copies.
- after a deploy: the service is active and its heartbeat reaches production.

## How to get to it (user POV)

SSH to the Pi at the LAN address in the project memory, with the operator's YubiKey.
Confirm the operator's current network first; never probe an address because it
appears in old notes.

## Driving it with bun run verify

It isn't: `bun run verify` never touches the Pi. Read-only operator checks:

```bash
ssh root@<pi> 'systemctl is-active sms-daemon; journalctl -u sms-daemon -n 100 --no-pager'
```

For the SMS store, use the `fetch-sms` skill (it runs sqlite through an ephemeral nix
shell; the Pi has no sqlite3).

## Gotchas

- Production. No restarts, no config edits, no AT commands, no test SMS, no writes to
  the store, unless the user explicitly asks for that specific action.
- The diagnostic binaries (`at_debug`, `modem_health`, `test_sms_delete`) talk to real
  modems; `test_sms_delete` deletes SMS from SIM storage. Never run them for a check.
- SIMs move between ports across reboots: identify a SIM by ICCID, never by port.
