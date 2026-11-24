# Voice Calls

Dashboard users answer and place calls on any managed SIM from the browser. Live
since 2026-09-17. This doc holds the hardware and Cloudflare facts the code relies
on; the code is listed under Components.

## Requirements

- Every managed SIM can receive and place calls, inbound and outbound.
- At most one call is active across the whole system, enforced in the Worker and
  in the daemon.
- No recording: audio is never written to disk, D1, KV, R2 or logs.
- Calling needs `messages.read`: whoever can read SMS can call.
- Receiving and sending SMS take priority over voice.

## Modem facts

The fleet is Quectel `EC20-CE-HDLG` (`2c7c:0125`), five USB interfaces: DIAG,
NMEA, AT, MODEM, QMI.

- Voice over USB (`AT+QPCMV=1,0`) carries call audio on the **NMEA port** as 8 kHz,
  16-bit, mono PCM. It must be enabled **before** the call is set up; issued during
  a call it returns `ERROR`, which is why the first test had no audio. It is not
  kept across module restarts.
- The module sends 640 bytes every 40 ms; the host must send 1600 bytes every
  100 ms. `+QPCMV: 0` means pause, `+QPCMV: 1` resume.
- The NMEA port must be released from GNSS first: `AT+QGPSCFG="outport","none"`.
- Every hangup, timeout and error path runs `ATH` and `AT+QPCMV=0`; without it the
  next call is silent.
- UAC (`AT+QPCMV=1,2`) returns `ERROR` on this firmware and would need a USB
  composition change the buses cannot afford.
- `orange-pi-daemon/scripts/slim-modem-usbcfg.sh` removes the NMEA interface; a
  slimmed modem cannot carry voice.
- URCs default to the AT port, which the daemon opens only per command, so
  `RING`/`+CLIP` would be lost. The daemon sets `AT+QURCCFG="urcport","usbmodem"`
  at discovery and keeps one reader per modem on the MODEM port (interface 3).
  SMS discovery polls `AT+CMGL`, so moving URCs does not affect it.
- Singapore has no 3G: calls need VoLTE and IMS registered (`AT+QCFG="ims"` reads
  `1,1`).

Tested on 2026-09-16, both directions, firmware `EC20CEHDLGR08A06M1G`: Singtel
(S86, S78) and M1 (S77, S74) on their home networks, and China Unicom, China
Mobile and China Telecom SIMs roaming on Singtel and StarHub. CMHK S66 failed both
ways: its IMS stays enabled but unregistered (`1,0`) while roaming.

## Architecture

```text
Browser (Dashboard)
  ⇅ WebRTC (Opus; TURN when needed)
Cloudflare Realtime SFU
  ⇅ two WebSocket adapters per call, `up` and `down` (the SFU dials out;
    PCM s16le 48 kHz stereo in protobuf Packet frames)
wss://voice-bridge.itoken.world:443 (DNS-only A record to the office IP,
  port 443 forwarded to the Pi, then nginx's SNI router)
  ⇅
Daemon voice bridge (8 kHz mono ⇄ 48 kHz stereo)
  ⇅ NMEA port: PCM      AT port: ATD / ATA / ATH / AT+CLCC / AT+QPCMV
EC20 ⇅ carrier VoLTE
```

Port 443 is shared with NetBird: nginx reads each ClientHello's SNI and forwards
the raw bytes, `voice-bridge.itoken.world` to the bridge on `127.0.0.1:8443`,
anything else to nginx's HTTPS listener. Both legs carry the PROXY protocol, so
the bridge sees the real source address its Cloudflare allowlist needs
(`orange-pi-daemon/src/proxy_protocol.rs`, `nixos-config/modules/netbird-server.nix`).

### Call flow

1. The browser gets ICE servers (`GET /api/calls/ice`), creates a PeerConnection
   with the microphone and sends its offer to `POST /api/calls/dial` (or
   `/api/calls/answer`). The Worker takes the single-call lock in the `CallState`
   Durable Object, creates the SFU session, publishes the mic as `mic` and returns
   the answer.
2. `POST /api/calls/connect` creates the `down` adapter (SFU streams `mic` to the
   Pi) and the `up` adapter (Pi feeds modem audio in as `modem`), then pulls
   `modem` into the browser session. **Creating the adapters is the command to the
   daemon**: their signed URLs carry the action, SIM and number.
3. The browser answers the pull offer through `POST /api/calls/renegotiate`.
4. The first admitted adapter connection makes the daemon enable `QPCMV` and run
   `ATD` or `ATA`; the second attaches to the same call.
5. A dashboard hangup closes the adapters and the daemon hangs up when its
   WebSocket drops. A far-end hangup (`NO CARRIER`, or `AT+CLCC` empty) makes the
   daemon close the WebSockets and call `POST /api/control/calls/ended`.

Incoming rings go to `POST /api/control/calls/incoming` and, if unanswered, to
`/api/control/calls/ended`. The daemon reports `RING` and the caller ID a few
hundred milliseconds apart; a partial unique index (migration `078`) allows one
open inbound row per SIM, so one ring is one call. The browser polls
`/api/calls/state` every 3 s while visible; that reads the Durable Object, and D1
is written only at call transitions (`calls`, migration `077`).

### Endpoint security

The listener is public, so every connection passes these before it can touch a
modem:

- **TLS**: the daemon gets a Let's Encrypt certificate itself over TLS-ALPN-01 on
  the same port (`rustls-acme`, cache in `/var/lib/sms-daemon/acme`); no DNS token
  is on the Pi. Challenge handshakes are answered before the allowlist.
- **Cloudflare allowlist**: other connections from outside Cloudflare's published
  ranges are dropped.
- **Signed path**: `/voice/{callId}/{leg}/{action}/{iccid}/{number}/{exp}/{sig}`,
  `sig` = HMAC-SHA256 with `SMS_API_KEY` over the other fields joined by newlines.
  A path cannot be changed to dial another number, expires after an hour, and a
  finished call cannot be restarted. The same test vector is asserted in
  `orange-pi-daemon/src/voice_auth.rs` and `sms-dashboard/server/handlers/calls.test.ts`.

### Realtime SFU quirks

- `sessions/new` never assigns a `trackName`, and adapters address audio by
  session plus track name. A call needs one browser session, two track operations
  and two adapters: a local adapter (`mode: buffer`) the Pi writes modem audio
  into, and a remote one (`mode: stream`) it reads browser audio from.
- `POST sessions/new` with **no body** returns a session; a body of `{}` returns
  400. "Optional" means omitting the body.
- RealtimeKit apps are a different product without the WebSocket adapter; the
  Worker needs a Realtime **SFU** app (`REALTIME_APP_ID`, `REALTIME_APP_SECRET`).
- Adapters reach the office IP directly; a proxied hostname or Cloudflare Tunnel is
  not needed and returned 522.

## Components

| Component | Code |
| --- | --- |
| Admission (path, HMAC, IP ranges) | `orange-pi-daemon/src/voice_auth.rs` |
| Listener, call lifecycle, audio pumps, URC readers | `orange-pi-daemon/src/voice_bridge.rs`, `voice_bridge/` |
| CLCC parsing, ring reporting | `orange-pi-daemon/src/voice_call.rs` |
| URC parsing | `orange-pi-daemon/src/urc_reader.rs` |
| Packet framing, resampling | `orange-pi-daemon/src/voice_codec.rs` |
| Host pacing and `+QPCMV` flow control | `orange-pi-daemon/src/voice_pacer.rs` |
| Enable switch | NixOS `services.sms-daemon.voiceBridgeDomain` |
| Worker routes | `sms-dashboard/server/handlers/calls.ts`, `call-*.ts`, `daemon-calls.ts` |
| Browser | `sms-dashboard/client/lib/call-session.ts`, `call-client.ts`, `call-ringtone.ts`, `CallPanel.svelte` |

## Not yet observed on a real call

- `AT+QPCMV=1,0` sent while an inbound call is ringing, right before `ATA`. If the
  module refuses it, inbound calls connect without audio and the command must
  move earlier, for example to the first `RING`.
- Whether `+QPCMV: 0` ever reaches the MODEM port, and how often the 300 ms queue
  cap drops browser audio.
- Packet sizes in both directions and end-to-end latency.

## Rejected alternatives

| Alternative | Reason |
| --- | --- |
| UAC sound card | Unavailable on this firmware; needs a USB composition change. |
| WebRTC stack on the Pi | The SFU's WebSocket adapter bridges WebRTC and PCM. |
| Durable Object media relay | A stateful service billed for every audio frame. |
| Cloudflare Tunnel or proxied hostname | The SFU reaches the office IP directly. |
| DNS-01 certificate on the Pi | Needs a Cloudflare DNS token on the Pi. |
| Asterisk with chan-quectel | A full PBX for one browser call. |
| Signaling through D1 | Polling would exhaust the D1 read quota. |

## References

- [EC2x&EG9x Voice Over USB and UAC Application Note](https://forums.quectel.com/uploads/short-url/xnztA07u1c4hilREu66LYIY6NGR.pdf)
- [eg25-manager issue on URC port and RING](https://gitlab.com/mobian1/eg25-manager/-/issues/13)
- [Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/)
- [Cloudflare Realtime WebSocket adapter](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/)
- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
