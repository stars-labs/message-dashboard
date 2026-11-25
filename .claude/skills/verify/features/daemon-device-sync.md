# Daemon: device sync

Every 30s the daemon posts `/api/control/devices`: one report per modem (equipment id,
detected ICCID, operator, signal, USB position, status). The Worker writes `modems`
only, never `sims`; `device_view` joins the two into the status every view shows.

## Sub-features

- full sync: `sync_mode: 'full'` with every present modem; a modem left out is
  disconnected (`processed.modems_disconnected`).
- SIM status: `device_view.sim_status` `active` / `offline` / error states from the
  modem's status and whether its detected ICCID matches.
- UI: SIM list chips 全部 / 在线 / 离线 / 异常, 设备与卡 状态 column, the stats bar,
  the yellow card-error banner.
- side effect on sending: only `active` SIMs are offered in 发送卡.

## How to get to it (user POV)

消息 (SIM list and stats bar) and 设备与卡.

## Driving it with bun run verify

```ts
const report = (n, iccid, operator, status) => ({ equipment_id: `86000000000000${n}`,
  detected_iccid: iccid, detected_operator: operator, detected_phone_number: null,
  manufacturer: 'Quectel', model: 'EC20F', firmware_revision: 'EC20CEFAG',
  hardware_revision: null, modem_index: n - 1, rssi: -60, signal_percent: 70, status,
  usb_path: `1-1.${n}`, usb_port: n });
await daemon('/api/control/devices', { body: { session_id: 'e2e-session',
  sync_mode: 'full', timestamp: new Date().toISOString(), removed_equipment_ids: [],
  modem_reports: [report(1, '8965000000000000001', 'SingTel', 'connected'),
                  report(2, '8965000000000000002', 'M1', 'disconnected')] } });
// D1: device_view S02 'offline'; UI after reload: 在线 1, 离线 2
```

Checked in: `scripts/verify/journeys/daemon-contract.ts` (offline) and
`sms-ai-reply.ts` (S03 brought online).

## Gotchas

- Use the seeded `session_id` `e2e-session`; it matches `daemon_health`.
- Bringing a seeded SIM online this way is the production path; never write `modems`
  with `d1()`.
- A modem's ICCID is `modems.detected_iccid`.
