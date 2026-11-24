# USB Topology

What bounds how many EC20 modems the Orange Pi can run, and how to tell which
limit you hit. Live counts come from the Pi (commands at the end; host and access
in [deployment.md](deployment.md)); where each modem sits comes from
`device_view.usb_path`.

## Controllers and sockets

A bus is one USB host controller, and the 127-address limit applies per bus.

| Bus | Controller | Socket |
|-----|-----------|--------|
| `usb1` | `fc800000.usb`, EHCI 480M | Socket A |
| `usb2` | `fc840000.usb`, OHCI 12M | Socket A, low/full-speed companion |
| `usb3` | `fc880000.usb`, EHCI 480M | Socket B |
| `usb4` | `fc8c0000.usb`, OHCI 12M | Socket B, low/full-speed companion |
| `usb5` / `usb6` | `xhci-hcd.5.auto`, xHCI | USB 3.0 socket, unused |

- Modems go on the two EHCI buses. xHCI gains nothing (the EC20 is USB 2.0 only)
  and runs out of per-device context memory at scale (`error -12`, ENOMEM).
- EHCI and its OHCI companion are two controllers on one socket. xHCI is one
  controller that registers two buses, because the USB 2 and SuperSpeed wire pairs
  are separate.
- Every root hub has one port (`maxchild=1`). A socket takes one cable; a second
  cable needs the small hub, at 4 addresses.

## Hub chips cost addresses

A hub's label counts sockets; the kernel counts chips, and each chip takes an
address before any modem is plugged in. An EC20 takes one address for all five of
its interfaces.

- **"100-port" hub**: 5 independent blocks, one cable each. A block is one
  `1a40:0201` 7-port MTT chip feeding five `1a40:0101` 4-port leaf chips: 20 sockets
  for 6 addresses, so 100 sockets for 30.
- **"10-port" small hub**: four `1a40:0101` chips, 10 sockets for 4 addresses.

Sockets are never the limit; addresses are. Two 100-port hubs on one bus cost
`1 root + 4 small hub + 60 = 65` addresses, leaving 62 for modems, so spreading
across two hubs on one bus loses modems. Expand on the bus with free addresses.

In practice each cable has held about 11 modems, not 20: every leaf chip carried
2–3 modems in an even pattern, which suggests module bodies too wide for adjacent
sockets. That is inferred, not checked at the rack.

## Two failure modes

**Signal integrity.** Deep hub chains produce protocol errors that drop modems:

```
usb 1-1.4.2: device descriptor read/8, error -71     ← the MTT chip itself
usb 1-1.4-port2: unable to enumerate USB device      ← a whole 20-socket block
```

`-71` (EPROTO) and `-32` (EPIPE) are this mode. The number of segments in the path
gives the blast radius: `1-1.4-port1` is a small-hub port and loses a whole block,
`1-1.3.3.4-port1` a leaf port and one modem. Repeated retries on one port mean an
intermittent fault. USB 2.0 allows 7 tiers; root → small hub (2 chips) → MTT → leaf
→ EC20 uses 4 external hub levels. On 2026-08-06 all 246 such lines came from `usb1` and none
from `usb3`. One untested explanation is the passive extension cables used on
`usb1` (voltage drop in LTE bursts, then re-enumeration); whether `usb3` is free of
them was not confirmed. A cable adds no tier and no address, only signal loss.

**Address exhaustion.** USB addresses are 7 bits and address 0 is reserved, so 127
per bus, shared by hubs and modems. Exhaustion prints nothing distinctive; never
diagnose it from error text, count instead. `device not accepting address N` is
printed only after address N was allocated, so it means an address was free.

## Identifying a modem

- **IMEI** (`AT+CGSN`, 15 digits) is the modem's identity and the join key:
  `device_view` matches `sims.imei = modems.equipment_id`.
- **`usb_path`** is its location, the kernel devpath. `1-1.A.B.C.D` is bus 1, root
  port 1, small-hub ports A and B, MTT port C (the cable), leaf port D (the modem).
  It survives reboot and replug, but not moving a cable.
- **ttyUSB number and USB address** change on every re-enumeration, even while
  the daemon runs. Use them only for the AT command you are about to send.
- **ICCID** is read with `AT+QCCID`; trailing `F` padding is stripped, which is
  why ICCIDs here have 19 or 20 digits. A SIM is `active` only when
  `modems.detected_iccid` matches `sims.iccid`.

An EC20 exposes DIAG, NMEA, AT, MODEM and QMI. `orange-pi-daemon/scripts/slim-modem-usbcfg.sh`
cuts a modem to AT and MODEM to save endpoints, but voice calls carry audio on the
NMEA port ([voice-calls.md](voice-calls.md)), so a slimmed modem cannot take
calls.

## Power

An EC20 can draw far more in an LTE burst than a USB port supplies. Every hub must
be externally powered; an underpowered hub shows up as dropouts, resets and `-71`
errors, the same as a signal problem.

## Commands

Run on the Pi:

```bash
lsusb | awk '{print $2}' | sort | uniq -c                      # addresses used per bus
dmesg | grep -iE 'unable to enumerate|not accepting address|error -(71|32|12)' | tail
lsusb -v 2>/dev/null | grep -i translator                       # a non-MTT hub serializes traffic
for t in /sys/class/tty/ttyUSB*; do                             # ttyUSB -> usb_path
  echo "$(basename "$t") -> $(readlink -f "$t/device" | grep -oE '[0-9]+-[0-9.]+' | tail -1)"
done
```

Stop `sms-daemon` before re-cabling and start it afterwards; its 60-second
rediscovery cannot see a modem that never enumerated.
