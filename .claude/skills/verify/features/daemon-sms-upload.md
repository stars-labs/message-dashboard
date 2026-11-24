# Daemon: SMS upload

The daemon reads SMS from each modem over AT commands, buffers them in its SQLite
store, and uploads them to `/api/control/messages`. The Worker stores each one, extracts
a verification code, applies filter rules and keyword tags, and links balance replies.

## Sub-features

- upload: `{ messages: [{ id, direction: 'received', phone_iccid, phone_number (the
  sender), content, timestamp }] }` → per-message `stored` result.
- code extraction: `messages.verification_code`, shown as the tappable code.
- filters and tags: rules hide a row (`filter_status`), keywords tag it.
- balance replies: a reply from a profile's sender links to a pending check (see
  [agent-sms-ai-run](agent-sms-ai-run.md)).

## How to get to it (user POV)

The new row appears in the 消息 feed (on the next poll, or a reload).

## Driving it with bun run verify

```ts
await daemon('/api/control/messages', { body: { messages: [{
  id: crypto.randomUUID(), direction: 'received', phone_iccid: '8965000000000000001',
  phone_number: 'BANK2', content: 'Your verification code is 135790.',
  timestamp: new Date().toISOString(),
}] } });
await p.reload();
await p.getByRole('button', { name: '135790', exact: true }).waitFor();
// D1: messages.verification_code = '135790' for phone_number 'BANK2'
```

Checked in: `scripts/verify/journeys/daemon-contract.ts`.

## Gotchas

- `phone_number` is the sender, not the SIM's number; the SIM is `phone_iccid`.
- The daemon retries an upload with the same `id`. A change to the upload path should
  prove, by posting the same message twice, that a retry does not duplicate the row
  (not yet driven here).
- Reading SMS off a real modem (PDU decoding, multipart assembly) is the daemon's unit
  tests; the live store on the Pi is read with the `fetch-sms` skill (see
  [daemon-live-pi](daemon-live-pi.md)).
