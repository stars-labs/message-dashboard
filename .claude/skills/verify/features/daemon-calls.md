# Daemon: voice calls

When a modem rings, the daemon reports `/api/control/calls/incoming`; the dashboard
rings and an operator can answer in the browser through the daemon's voice bridge. The
daemon reports `/api/control/calls/ended` when the call ends.

## Sub-features

- incoming: `{ from, iccid }` → `{ ok: true, call: { id, state: 'ringing', … } }`.
  Repeated rings on the same SIM return the same call (the modem repeats RING).
- busy: a ring on another SIM, or while a call is answered → 409
  `{ ok: false, reason: 'another call is active' }`.
- ended: `{ call_id, iccid, reason }` → the call is recorded; unanswered is `missed`.
- UI: 通话 (header, `aria-haspopup=dialog`) and the call layer; history in the calls
  panel.

## How to get to it (user POV)

Desktop header 通话; mobile 更多 → 语音通话. A ringing call appears on its own.

## Driving it with bun run verify

```ts
const ring = await daemon('/api/control/calls/incoming', {
  body: { from: '+6591230000', iccid: '8965000000000000001' } }); // 200, ringing
const busy = await daemon('/api/control/calls/incoming', {
  body: { from: '+6591230001', iccid: '8965000000000000002' } }); // 409
await daemon('/api/control/calls/ended', {
  body: { call_id: ring.body.call.id, iccid: '8965000000000000001', reason: 'remote_hangup' } });
// D1: calls.outcome 'missed' for +6591230000
```

Checked in: `scripts/verify/journeys/daemon-contract.ts`.

## Gotchas

- Answering needs the voice bridge (TLS on the Pi, `VOICE_BRIDGE_DOMAIN`) and WebRTC;
  that is not drivable locally. The ringing UI and the records are.
- The seed has one answered inbound call on S01; read it before asserting on history.
