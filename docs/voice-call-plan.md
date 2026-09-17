# Voice Call Plan

## Status

Drafted 2026-09-15. Requirements confirmed; voice feasibility passed on Singtel,
M1 and the roaming China Mobile/Unicom/Telecom SIMs (2026-09-16); URC routing
passed (2026-09-16); adapter reachability passed (2026-09-17).

**Implemented, not deployed (2026-09-17):** daemon voice bridge, Worker call
routes and the Dashboard call panel. Nothing has run end to end yet. Before the
first production call, deploy the Pi and the Worker, confirm the certificate was
issued, then place one approved test call. Open hardware questions are listed
under "Unverified" below.

The Orange Pi has been resetting without logs since 2026-09-13. A reset drops
any active call.

## Goal

Let Dashboard users answer incoming calls and place outgoing calls on any
managed SIM from the browser, without recording audio.

## Confirmed Requirements

- Every managed SIM can receive and place calls.
- Both inbound and outbound calls are supported.
- At most one call is active across the whole system.
- No recording. Call audio is never persisted, so there is no compliance scope.
- Authorization reuses `messages.read`: anyone who can read SMS can call.

## Constraints

### Modem

- Modems are Quectel `EC20-CE-HDLG` (`2c7c:0125`). The default USB composition
  exposes five interfaces: DIAG, NMEA, AT, MODEM, and QMI.
- Voice over USB (`AT+QPCMV=1,0`) carries call audio on the NMEA port as 8 kHz,
  16-bit linear, mono PCM. **It must be enabled before the call is set up**; the
  module answers `ERROR` if it is issued while a call is already active. The module sends 640 bytes every 40 ms; the host must
  send 1600 bytes every 100 ms. URC `+QPCMV: 0` means the module is busy and the
  host must pause; `+QPCMV: 1` resumes. The setting is not persisted across
  module restarts. The NMEA port must first be released from GNSS with
  `AT+QGPSCFG="outport","none"`.
- `AT+QPCMV=0` must run on every hangup; community reports show silent follow-up
  calls otherwise.
- `orange-pi-daemon/scripts/slim-modem-usbcfg.sh` removes the NMEA interface. A
  slimmed modem cannot carry voice. One modem was slimmed as of 2026-09-15.
- Singapore shut down 3G, so calls on Singapore SIMs require VoLTE. VoLTE voice on
  EC20-CE firmware is unverified; forum reports describe IMS registered with SMS
  and data working but calls failing.

### Daemon

- The daemon opens the AT port per command and closes it after the response.
  Nothing reads the port in between, so `RING`/`+CLIP` URCs are lost.
- The default URC port is `usbat`. The firmware accepts `"usbat"`, `"usbmodem"`,
  `"uart1"`, `"uart2"`, and `"all"`, so URCs can be routed to the otherwise
  unused MODEM port (interface 3) and read there without touching the AT port.
- Each modem is revisited roughly every 9 seconds by the scan loop.

### Worker

- The Worker binds D1 and KV only; there are no Durable Objects or WebSockets.
- The daemon pulls work from the Worker. D1 row-read quota has been exceeded
  before, so high-frequency signaling must not read D1.

## Architecture

```text
Browser (Dashboard)
  ⇅ WebRTC (Opus; TURN when needed)
Cloudflare Realtime SFU
  ⇅ two WebSocket adapters per call, `up` and `down` (the SFU dials out;
    PCM s16le 48 kHz stereo in protobuf Packet frames)
wss://voice-bridge.itoken.world:443 — DNS-only A record to the office IP,
  port 443 forwarded to the Pi
  ⇅
Daemon voice bridge (8 kHz mono ⇄ 48 kHz stereo)
  ⇅ NMEA port: PCM      AT port: ATD / ATA / ATH / AT+CLCC / AT+QPCMV
EC20 ⇅ carrier VoLTE
```

### Call flow

1. Browser gets ICE servers (`GET /api/calls/ice`), creates a PeerConnection with
   the microphone, and sends its offer to `POST /api/calls/dial` (or
   `/api/calls/answer` for a ringing call). The Worker takes the KV lock, creates
   the SFU session, publishes the mic as track `mic`, and returns the answer.
2. Once the PeerConnection is connected, `POST /api/calls/connect` creates the
   `down` adapter (SFU streams `mic` to the Pi) and the `up` adapter (Pi feeds
   modem audio in as `modem`), then pulls `modem` into the browser session.
   **Creating the adapters is the command to the daemon**: their signed endpoint
   URLs carry the action, SIM and number.
3. The browser answers the pull offer through `POST /api/calls/renegotiate`.
4. The first admitted adapter connection makes the daemon enable `QPCMV` and run
   `ATD` or `ATA`; the second attaches to the same call.
5. Ending: Dashboard hangup closes the adapters, and the daemon hangs up when its
   WebSocket drops. A far-end hangup (URC `NO CARRIER` or `AT+CLCC` empty) makes
   the daemon close the WebSockets and call `POST /api/control/calls/ended`,
   which closes the adapters and clears the lock. The Dashboard polls
   `/api/calls/state` every 3 s while visible and releases media when it clears.

Incoming: one reader per voice-capable modem on the MODEM port reports every
ring to `POST /api/control/calls/incoming` (60 s KV TTL, the KV minimum) and an
unanswered ring that stops to `/api/control/calls/ended`.

### Endpoint security

The listener is public, so each connection passes both checks before it can
touch a modem:

- **TLS**: the daemon obtains a Let's Encrypt certificate itself over TLS-ALPN-01
  on the same port (`rustls-acme`, cache in `/var/lib/sms-daemon/acme`). No DNS
  token lives on the Pi. Challenge handshakes are answered before the allowlist,
  because Let's Encrypt validates from its own addresses.
- **Cloudflare allowlist**: non-challenge connections from outside Cloudflare's
  published ranges are dropped.
- **Signed path**: `/voice/{callId}/{leg}/{action}/{iccid}/{number}/{exp}/{sig}`,
  `sig` = HMAC-SHA256 with the existing shared `SMS_API_KEY` over the other
  fields joined by newlines; segments are percent-encoded. A path cannot be
  changed to dial another number, expires after an hour, and a finished call id
  cannot be restarted. The same test vector is asserted in
  `orange-pi-daemon/src/voice_auth.rs` and `sms-dashboard/server/api/calls.test.js`.

### Components

| Component | Code |
| --- | --- |
| Admission (path, HMAC, IP ranges) | `orange-pi-daemon/src/voice_auth.rs` |
| Listener, call lifecycle, audio pumps, URC readers | `orange-pi-daemon/src/voice_bridge.rs` |
| CLCC parsing, ring reporting | `orange-pi-daemon/src/voice_call.rs` |
| URC parsing | `orange-pi-daemon/src/urc_reader.rs` |
| Packet framing, resampling | `orange-pi-daemon/src/voice_codec.rs` |
| Enable switch | NixOS `services.sms-daemon.voiceBridgeDomain` (adds `CAP_NET_BIND_SERVICE`) |
| Worker routes | `sms-dashboard/server/api/calls.js` |
| Call log schema | `sms-dashboard/migrations/077_add_call_log.sql` |
| Browser orchestration | `sms-dashboard/client/lib/call-session.js`, `call-client.js` |
| UI | `sms-dashboard/client/lib/CallPanel.svelte`, wired in `App.svelte` |
| Incoming ringtone | `sms-dashboard/client/lib/call-ringtone.js` |

### Unverified

- `AT+QPCMV=1,0` while an incoming call is **ringing**. Feasibility tests enabled
  it before the call arrived. The daemon sends it right before `ATA` and logs a
  refusal instead of failing; if it is refused, inbound calls connect without
  audio and the setting has to move earlier (for example on the first `RING`).
- `+QPCMV: 0` flow control is not honoured yet; browser audio is written to the
  NMEA port as it arrives.
- Adapter behaviour over `wss://` with a real certificate, packet sizes in both
  directions, and end-to-end latency.

### Media topology (from the Realtime OpenAPI schema, 2026-09-17)

`sessions/new` returns only a `sessionId`; it never assigns a `trackName`. A
`trackName` exists only once a track is added through `tracks/new`, and the
WebSocket adapter addresses audio by `sessionId` plus `trackName`. A call
therefore needs one browser session, two track operations and two adapters:

| Direction | Operation | Key fields |
| --- | --- | --- |
| Browser mic -> SFU | browser session `tracks/new` | `location: local`, `trackName: caller-mic` |
| Modem audio -> SFU | **local adapter** — the SFU connects out to the Pi and pulls PCM | `location: local`, `inputCodec: pcm`, `mode: buffer` |
| SFU -> browser speaker | browser session `tracks/new` pulling the adapter's track; **needs a renegotiate round trip** | `location: remote`, `sessionId: <adapter session>` |
| Browser mic -> Pi | **remote adapter** — the SFU streams PCM out to the Pi | `location: remote`, `sessionId: <browser session>`, `outputCodec: pcm`, `mode: stream` |

The schema says `mode: buffer` is for local adapters and `mode: stream` for
remote ones. The voice bridge on the Pi therefore serves two WebSocket
connections per call: one it writes modem PCM into, one it reads browser PCM
from.

Session creation without an SDP was checked against the live API on
2026-09-17: `POST sessions/new` with **no request body** returns 201 with a
`sessionId`, while a body of `{}` returns 400 (`sessionDescription` required).
The schema's "optional" means omitting the body, not sending an empty object.
Session creation and publishing the mic can therefore be separate steps.

### Adapter reachability (verified 2026-09-17)

A local SFU adapter was created against `ws://203.116.47.202:443/adapter-test`
— the office public IP, with no Cloudflare proxy, no Origin Rule and no TLS —
while the Pi captured inbound SYNs:

| Observation | Result |
| --- | --- |
| Positive control, direct from `213.35.97.233` | HTTP 400, SYN captured |
| Adapter creation | Succeeded (`adapterId b97be173…`) |
| Inbound SYN on the Pi | From `172.70.204.71`, inside Cloudflare's published `172.64.0.0/13` |
| websocat on the Pi | `Incoming TCP connection from 172.70.204.71`, then `Incoming connection to websocket: /adapter-test` |

Conclusions:

- The office network does not block Cloudflare. The SFU connects out to the Pi
  and completes the WebSocket upgrade on the requested path. Remote (egress)
  adapters connect in the same direction, so both adapter types use this path.
- The adapter accepts plain `ws://`.
- The earlier 522s on `voice-bridge.itoken.world` are specific to the Cloudflare
  proxy and Origin Rule path. Proxied requests never reached the Pi even with the
  rule active, and Cloudflare Trace failed with a 504, so that path was not
  diagnosed further.
- **The proxied hostname is not needed.** Browsers talk only to the SFU over
  WebRTC and never reach the Pi, and the adapter can target the office IP
  directly. The DNS record, the Origin Rule and any certificate on the Pi become
  unnecessary unless the adapter hop must be encrypted.

Decided on 2026-09-17: encrypt the hop with `wss://`, authenticate with a
signed path plus the Cloudflare allowlist, and target the static office IP
through a DNS-only record. See "Endpoint security".

### Rejected Alternatives

| Alternative | Reason |
| --- | --- |
| UAC sound card (`AT+QPCMV=1,2`) | Requires `AT+QCFG="USBCFG"` and re-enumeration, and adds isochronous endpoints to buses already short on controller resources. |
| WebRTC stack on the Pi | The WebSocket adapter bridges WebRTC and PCM inside the SFU. |
| Durable Object media relay | Adds a stateful service billed by duration for every audio frame. |
| Cloudflare Tunnel or proxied hostname | The SFU reaches the office IP directly; proxied requests returned 522 and added nothing. |
| DNS-01 certificate on the Pi | Needs a Cloudflare DNS token on the Pi; TLS-ALPN-01 on the listener needs no secret. |
| New shared secret for adapter auth | `SMS_API_KEY` is already shared by the Worker and the daemon. |
| Asterisk with chan-quectel | Adds a full PBX for a single-call, browser-only use case. |
| Signaling through D1 | Frequent polling would hit the D1 read quota again. |

## Confirmation Sequence

### 1. Confirm the product requirement

Confirmed on 2026-09-15. See the decision log.

### 2. Confirm voice feasibility on production SIMs

Run in an approved maintenance window, one SIM at a time, starting with a
low-risk SIM from each carrier cohort (Singtel, M1, StarHub, CMHK, and the
roaming mainland China carriers). Stop the daemon's access to the modem under
test first. Use only operator-owned numbers.

Pass criteria:

- IMS/VoLTE registration is reported by the modem.
- An outbound `ATD` call connects and is audible on the far end.
- An inbound call produces `RING` and `+CLIP` on the configured URC port.
- `AT+QPCMV=1,0` records far-end audio from the NMEA port and plays a known PCM
  file to the far end.
- `ATH` and `AT+QPCMV=0` tear the call down and a second call works.
- SMS reception on that modem works after the test.

If VoLTE voice fails, record the firmware and MBN versions and stop. Firmware or
MBN changes need their own plan.

#### Singtel evidence: S86 and S78 on 2026-09-16

- SIMs: S86 `+6597817169` (ICCID `8965012306052373985`, USB `1-1.3.4.3.4`) and
  S78 `+6592953543` (ICCID `8965012211290057038`, USB `1-1.3.4.6.3`). Both are
  carrier-account-verified Singtel postpaid lines with five USB interfaces.
- Firmware on both: `EC20CEHDLGR08A06M1G` (EC20F).
- Registration: `+COPS: 0,0,"Singtel Singtel",7`, `+QNWINFO: "FDD LTE","52501",
  "LTE BAND 3"`, `+CEREG: 0,1`, `+QCFG: "ims",1,1`. Home network, not roaming.
- **A -> B passed**: caller reached `stat=2` then `stat=3`, callee raised
  `+CLCC: 4,1,4,0,0,"97817169"` (ringing with caller ID), `ATA` moved both to
  `stat=0`, and `ATH` cleared the voice call on both sides.
- **B -> A passed** with the same sequence and caller ID `"92953543"`.
- Audio over USB worked once `AT+QPCMV=1,0` was issued before dialing. In five
  seconds the NMEA ports delivered 80960 / 73280 bytes (A->B) and 80320 / 74240
  bytes (B->A) against an expected 80000. The caller side matches the documented
  16000 bytes/s exactly; the callee side ran about 8% short, most likely because
  capture started a moment after the stream did. Worth re-measuring during the
  bridge work, but it does not block the design.
- `AT+QPCMV=1,2` (UAC) returns `ERROR` on this firmware, and `AT+QCFG="usbcfg"`
  reports the UAC function bit disabled. The NMEA path is the only option here,
  which is what this plan already assumes.
- GNSS was not holding the NMEA port (`+QGPS: 0`, `+QGPSCFG: "outport",none`).
- `sms-daemon` was stopped for the test and restored to `active` afterwards;
  all 370 `ttyUSB` nodes were present again and the Pi did not reset.

#### M1 evidence: S77 and S74 on 2026-09-16

- SIMs: S77 `+6590421798` (ICCID `8965030124051507919`, USB `1-1.2.4.4.2`) and
  S74 `+6591936675` (ICCID `8965030124051507927`, USB `1-1.2.4.2.4`), both
  carrier-account-verified M1 prepaid lines on different USB hubs.
- Registration: `+COPS: 0,0,"SGP-M1",7`, `+QNWINFO: "FDD LTE","52503","LTE BAND
  3"`, `+CEREG: 0,1`, `+QCFG: "ims",1,1`. Home network.
- **Both directions passed**: ringing with caller ID (`90421798` and
  `91936675`), `ATA` brought both sides to `stat=0`, and `ATH` cleared the voice
  call cleanly.
- PCM over five seconds: 80000 / 80320 bytes (A->B) and 81600 / 80320 (B->A)
  against an expected 80000. All four figures sit on the documented 16000
  bytes/s, which also explains the Singtel callee shortfall as a capture-start
  artefact rather than a systematic loss.

#### Roaming cohort evidence: 2026-09-16

All mainland China and Hong Kong SIMs roam in Singapore, so these were real
international calls.

| Pair | Roaming network | MCC | IMS | Result |
| --- | --- | --- | --- | --- |
| 联通 S1 `+8617600419127` ↔ 移动 S2 `+8613520607015` | Singtel / Singtel CMCC | 52501 | `1,1` | **Both directions passed**, PCM 80320/71680 and 80320/80320 |
| 电信 S55 `+8615311930395` ↔ 移动 HK S66 `+85246820057` | StarHub / StarHub CMHK | 52505 | `1,1` / **`1,0`** | **Both directions failed**: the callee never rang |

`AT+QCFG="ims"` reports enable and registration. Every SIM that placed a call
shows `1,1`; S66 shows `1,0` — enabled but not registered.

An isolation test settled the cause. China Telecom S55, roaming on StarHub with
IMS `1,1`, was paired with the known-good Singtel S86:

| Direction | Result | PCM |
| --- | --- | --- |
| 电信 S55 -> Singtel S86 | **Pass** | 82240 / 78271 |
| Singtel S86 -> 电信 S55 | **Pass** | 80000 / 80640 |

So StarHub roaming, the China Telecom SIM, and international routing between a
mainland number and a Singapore number are all fine. The only remaining variable
is S66, whose IMS never registered, which accounts for it failing in both
directions — an unregistered IMS cannot place a call and cannot be reached.

`+CEREG: 0,5` on all of them confirms they are attached as roaming, so the
failure was never attachment.

### 3. Confirm URC routing

Verify which `AT+QURCCFG="urcport"` values the firmware accepts, whether the
setting survives a module restart, and that routing URCs away from the AT port
does not affect `+CMTI` handling in the daemon.

#### Evidence: S86 on 2026-09-16

- `AT+QURCCFG=?` returns `("usbat","usbmodem","uart1","uart2","all")`; the
  default was `usbat`.
- Setting `AT+QURCCFG="urcport","usbmodem"` returned `OK` and read back
  correctly.
- With a plain reader on the MODEM port (interface 3) and an inbound call from
  S78, the port delivered `RING`, `+CLIP: "92953543",128,...`, `RING`, `+CLIP`,
  then `NO CARRIER` — 96 bytes total. Inbound detection with caller ID works on
  a port the daemon never opens.
- The setting was restored to `usbat` and `sms-daemon` was restarted.

The `+CMTI` concern is closed: the daemon has no URC handling at all. It
discovers SMS by polling `AT+CMGL="ALL"` and `AT+CMGL=4` on its scan cycle, so
moving `urcport` to `usbmodem` cannot affect message collection.

Module-reset persistence is left untested on purpose: the daemon will set
`urcport` on every modem at discovery time, next to the existing IMS init, which
makes the question moot.

### 4. Confirm the media transport

With a test SFU app: establish the tunnel hostname, authenticate the adapter
endpoint, verify ingest and egress framing, and measure mouth-to-ear latency
between a browser and a file-backed bridge.

### 5. Confirm the technical design

Confirm the API shape, KV keys, D1 call-log schema, and daemon task structure
before implementation.

### 6. Confirm staged rollout

1. Incoming call detection and a missed-call list.
2. Answer incoming calls in the browser.
3. Place outgoing calls from the Dashboard.

## Safety and Rollback Rules

- No production test call without explicit approval for that session.
- Voice features start disabled and require an explicit production enable.
  Disabling stops new calls without a daemon rollback.
- The one-call limit is enforced in the Worker and in the daemon.
- Every timeout, error, and hangup path runs `ATH` and `AT+QPCMV=0` and releases
  the modem.
- Receiving and sending SMS take priority over voice.
- Audio is never written to disk, D1, KV, R2, or logs.
- Do not run `slim-modem-usbcfg.sh` on modems that must carry voice.

## Decision Log

| Date | Item | Decision | Evidence/notes |
| --- | --- | --- | --- |
| 2026-09-15 | 1a. SIM scope | Confirmed | Every managed SIM must support calls. |
| 2026-09-15 | 1b. Directions | Confirmed | Inbound and outbound. |
| 2026-09-15 | 1c. Concurrency | Confirmed | At most one active call across the system. |
| 2026-09-15 | 1d. Recording | Confirmed | No recording; no compliance scope. |
| 2026-09-15 | 1e. Authorization | Confirmed | Reuse `messages.read`. |
| 2026-09-15 | Audio path | Proposed | Voice over USB on the NMEA port instead of UAC. Both are 8 kHz mono; UAC needs a USB composition change the bus cannot afford. |
| 2026-09-15 | Media transport | Proposed | Realtime SFU with WebSocket adapters and a Cloudflare Tunnel. No Pi WebRTC stack, Durable Object relay, or Asterisk. |
| 2026-09-15 | Signaling | Proposed | KV state and daemon pull; D1 only for call-log rows. |
| 2026-09-16 | 2. Voice feasibility (Singtel) | Passed | S86 and S78 connected both ways over VoLTE on the Singtel home network, with caller ID, clean `ATH` teardown, and 8 kHz mono PCM on the NMEA ports. Firmware `EC20CEHDLGR08A06M1G`. |
| 2026-09-16 | QPCMV ordering | Confirmed | `AT+QPCMV=1,0` must be enabled before call setup. Issued mid-call it returns `ERROR`; this caused the first test run to report no audio. |
| 2026-09-16 | UAC availability | Closed | `AT+QPCMV=1,2` returns `ERROR` and `usbcfg` shows the UAC bit off, so UAC is unavailable without a USB composition change. Confirms the NMEA-port decision. |
| 2026-09-16 | 2. Roaming cohorts | Mostly passed | China Unicom, China Mobile and China Telecom all place and receive VoLTE calls while roaming in Singapore (Singtel and StarHub). Only Hong Kong Mobile S66 failed, in both directions, and an isolation test pinned the cause to its own IMS never registering (`+QCFG: "ims",1,0`) rather than the roaming network, the SIM cohort, or international routing. |
| 2026-09-16 | HK SIM IMS registration | Open | S66 `+85246820057` reports IMS enabled but unregistered while roaming on StarHub CMHK. Whether the other two HK SIMs behave the same, and whether it is a carrier-side roaming-VoLTE restriction, is unexamined. |
| 2026-09-16 | 2. Other carrier cohorts | Partly done | M1 passed in both directions (S77 and S74). China Mobile/Unicom/Telecom and Hong Kong Mobile remain unvalidated: those SIMs roam in Singapore, so testing them places international/roaming calls and needs an explicit cost decision. `sims` has no StarHub or CMHK carrier rows — the "StarHub" labels in the old inventory CSV are registered networks, not card carriers. |
| 2026-09-16 | 2. Voice feasibility (M1) | Passed | S77 and S74 connected both ways on `SGP-M1` with caller ID, clean teardown, and PCM byte counts matching 16000 bytes/s on all four measurements. |
| 2026-09-16 | 3. URC routing | Passed | `usbmodem` is supported. `RING` and `+CLIP` with caller ID were captured on the MODEM port (interface 3) during an inbound call, with the AT port untouched. Restored to `usbat` after the test. |
| 2026-09-16 | Inbound design | Decided | One persistent reader per modem on the MODEM port, with `urcport` set at discovery time alongside the existing IMS init. CLCC polling is no longer needed as a fallback. |
| 2026-09-16 | `+CMTI` risk | Closed | The daemon has no URC handling; SMS discovery polls `AT+CMGL`. Routing URCs to the MODEM port cannot affect message collection. |
| 2026-09-16 | Reset investigation | Open | On-site power check found nothing. Panic, OOM, thermal, watchdog, USB-PD and SD I/O errors are all ruled out by logs. Cause unknown; resets continue (three on 2026-09-16, two of which interrupted deploys). |
| 2026-09-16 | Daemon: URC routing at discovery | Implemented (not deployed) | `AtModemManager::init_urc_port` sends `AT+QURCCFG="urcport","usbmodem"` from `discover_modems`, next to the existing IMS init, so a module reset cannot leave it unset. |
| 2026-09-16 | Daemon: MODEM port lookup | Implemented (not deployed) | `pick_modem_port` derives interface 3 from the existing per-USB-device port grouping (index 2 is AT, so index 3 is MODEM). Pure function with unit tests; the sysfs wrapper is `modem_port_for_at_port`. |
| 2026-09-16 | Daemon: URC parsing | Implemented (not deployed) | New `urc_reader` module parses `RING`, `+CLIP`, `NO CARRIER`, and `+QPCMV` flow control, using the exact strings captured from the modem on 2026-09-16. Seven unit tests; one of them caught a real bug where a withheld caller ID parsed as garbage. |
| 2026-09-16 | `urcport` verified on hardware | Confirmed | Three modems on different hubs all report `+QURCCFG: "urcport","usbmodem"` after generation 378. The success log is `debug!` while the daemon runs at `RUST_LOG=…=info`, so the zero success count in the journal was a logging artefact, not a failure; `IMS enabled on` is absent for the same reason, and no `warn!` failures were logged. Verify this on the modem, not in the log. |
| 2026-09-16 | Daemon increments deployed | Done | Generation 378 carries `init_urc_port`, `pick_modem_port` and the `urc_reader` module. The first attempt failed because `urc_reader.rs` was untracked and Nix excludes untracked files from the flake source (`E0583`); staging it fixed the build. The Pi reset mid-build and the detached `systemd-run` unit was relaunched automatically, resuming from the store — the first deploy to survive a reset. |
| 2026-09-16 | TURN credentials | Verified | The TURN key generates short-lived ICE servers (HTTP 201), covering STUN plus TURN over UDP 3478, TCP 3478/80 and TLS 5349/443. |
| 2026-09-16 | RealtimeKit is not the SFU | Blocking | The app supplied (`a6659467-…`) is a RealtimeKit app. Probing the SFU API returns the same 404 as a non-existent UUID, so the two products use separate namespaces. RealtimeKit is a prebuilt meeting SDK and does not expose the WebSocket adapter this plan depends on. A Realtime **SFU** app (App ID plus App Secret) is still needed, created under Realtime → SFU. |
| 2026-09-17 | Adapter reachability | Verified | A local SFU adapter reached the Pi directly at `ws://203.116.47.202:443` from Cloudflare IP `172.70.204.71` and completed the WebSocket upgrade. The office network does not block Cloudflare, and the proxied `voice-bridge.itoken.world` hostname is not needed for adapters. |
| 2026-09-17 | Worker dial flow | Incomplete — redesign required | `/api/calls/dial` calls only `sessions/new`, which never assigns a `trackName`, so no adapter can ever address the call's audio. The unit tests pass because they cover auth, the single-call lock and input validation, not the media path. The browser-Worker contract assumed one round trip; the real flow publishes a local track, pulls a remote track with a renegotiate, and creates two adapters. `call-client.js` `dial()` and the Worker route both need rewriting against the schema. |
| 2026-09-16 | Daemon: reader task | Superseded 2026-09-17 | The persistent MODEM-port reader (TASK 9) and its wiring in `main.rs` remain. Every prerequisite is now in place: `urcport` is live on the modems, `pick_modem_port` locates interface 3, `parse_urc_line` is tested, and `open_serial` is reusable within the crate. It still needs a deploy plus an observation window to mean anything, and the Pi reset again during the generation 378 build. |
| 2026-09-16 | Worker, SFU and frontend | Superseded 2026-09-17 | Nothing is written. Blocked on a Cloudflare Realtime application (App ID and App Secret), a TURN key, a tunnel hostname, and a Cloudflare Tunnel token. `wrangler` 4.119 cannot provision Realtime, so these are Dashboard or REST API actions. |
| 2026-09-16 | Pre-existing flaky test | Fixed | `test_modem_manager_new_default_mode` raced its siblings over the process-global `USE_DBUS`. The 18 tests that mutate it now take a shared lock; six consecutive parallel runs pass, where two of four failed before. |
| 2026-09-16 | SD card wear | Noted | Root filesystem is a 32 GB SD card (SC32G, 09/2021) with 16 TB lifetime writes and no health telemetry; journald holds 934 MB persistent. Not linked to the resets, but a reliability risk worth reducing before rollout. |
| 2026-09-17 | Adapter hop encryption | Decided | `wss://` with a Let's Encrypt certificate obtained by the daemon over TLS-ALPN-01. `voice-bridge.itoken.world` switched to DNS-only → `203.116.47.202`, TTL 300. The Origin Rule is now inert (it only applies to proxied traffic); the DNS token lacks Rulesets permission, so it must be deleted in the Dashboard. |
| 2026-09-17 | Adapter endpoint auth | Decided | HMAC-signed path with `SMS_API_KEY` plus Cloudflare IP allowlist. Office IP confirmed static. |
| 2026-09-17 | Voice bridge, Worker flow, Dashboard panel | Implemented (not deployed) | Daemon `check-daemon` passes (148 lib tests, including 30 voice tests). Dashboard `bun run test` 936/937 — the one failure is the pre-existing uncommitted `auth0.test.js` case — and `bun run build` passes. Enabled on the Pi through `voiceBridgeDomain` in `flake.nix`. |
| 2026-09-17 | Deployed | Live | Worker version `eb998a98`, Pi generation 379. Verified on hardware: certificate issued over TLS-ALPN-01, 443 listening as the service user, non-Cloudflare clients dropped before the certificate is sent, 92 URC readers attached, and an inbound ring from S78 reached the Worker with caller id `92953543`. After an unrelated Pi reset the bridge came back on its own and reloaded the cached certificate (`DeployedCachedCert`), so a reset costs no Let's Encrypt issuance. |
| 2026-09-17 | Dashboard call UI | Rebuilt | The first pass listed SIMs by a `phone_number` field that `/api/phones` does not return, so every card showed its ICCID. Replaced with a searchable card picker (`S86 🇸🇬 +65…`), an in-call view with duration and mute, an incoming view with answer/reject, a ringtone plus tab-title takeover for inbound calls, a live timer in the top bar, and dialing disabled with a reason while the daemon is offline. |
| 2026-09-17 | Call audio | Connects; verified by the operator | The first end-to-end call reached the modem: both adapters connected from Cloudflare, `AT+QPCMV=1,0` was accepted, and teardown was clean (`adapter_closed`). The operator confirmed calls connect. Audio quality, pacing and `+QPCMV` flow control are still unmeasured, and no inbound call has been answered with audio checked. |
| 2026-09-17 | Call history | Added | D1 table `calls` (migration 077), written at start, answer and end; `GET /api/calls/history` lists it, enriched from `device_view`. Outcomes: answered, missed, rejected, cancelled, failed. Talk time is `ended_at - answered_at`, so an unanswered call is 0. The active call stays in KV, so three-second polling still never reads D1, and rows still in progress are excluded from the log to avoid showing the live call twice. |
| 2026-09-17 | One ring, two rows | Fixed (second attempt) | The daemon reports `RING` and the caller id a few hundred milliseconds apart. Both read the KV lock to decide whether the call is new, and eventually consistent reads showed no call to either, so each minted its own call id — every missed call appeared twice, one row never ending. Identity now comes from D1: an inbound report reuses the open row for that SIM from the last two minutes. An unanswered ring left open is also swept after five minutes as `missed` rather than after two hours as `failed`.<br>Reading D1 first was not enough: the second report can arrive before the first one's INSERT commits, so a live ring still logged twice. The database now arbitrates — migration 078 adds a partial unique index allowing one open inbound row per SIM, the losing INSERT is ignored, and the loser reads back the winner. Verified in production: the next ring produced exactly one row. |

## References

- [EC2x&EG9x Voice Over USB and UAC Application Note](https://forums.quectel.com/uploads/short-url/xnztA07u1c4hilREu66LYIY6NGR.pdf)
- [asterisk-chan-quectel discussion on UAC](https://github.com/IchthysMaranatha/asterisk-chan-quectel/discussions/2)
- [eg25-manager issue on URC port and RING](https://gitlab.com/mobian1/eg25-manager/-/issues/13)
- [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/)
- [Cloudflare Realtime WebSocket adapter](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/)
- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
