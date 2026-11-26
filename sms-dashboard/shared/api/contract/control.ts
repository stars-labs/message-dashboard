import * as v from 'valibot';
import {
  EndedCallBody,
  EndedCallResponse,
  IncomingCallBody,
  IncomingCallResponse,
} from '../calls.js';
import {
  DevicesBody,
  DevicesResponse,
  PendingSmsHeaders,
  PendingSmsResponse,
  SmsResultBody,
  SmsResultResponse,
  UploadBody,
  UploadResponse,
} from '../daemon.js';
import { NOT_JSON_MESSAGE } from '../body.js';
import { PollHeaders } from '../../recurring.js';
import { route } from './route.js';

const DAEMON = { kind: 'daemon', errors: 'flagged' } as const;

export const HeartbeatResponse = v.object({
  success: v.literal(true),
  message: v.string(),
  received_at: v.string(),
});

export type HeartbeatResponse = v.InferOutput<typeof HeartbeatResponse>;

/** The Pi daemon's routes; their wire format is pinned by shared/control-fixtures/. */
export const control = {
  // The snapshot is read field by field (normalizeHealthSnapshot), so a daemon a version
  // ahead or behind gets the same refusal.
  heartbeat: route(DAEMON, 'POST', '/api/control/heartbeat')
    .route({ outputStructure: 'detailed' })
    .input(
      v.pipe(
        v.unknown(),
        v.check((body) => body !== undefined, NOT_JSON_MESSAGE),
      ),
    )
    .output(v.object({ headers: PollHeaders, body: HeartbeatResponse })),
  // Refuses a report in { error }.
  devices: route({ kind: 'daemon', errors: 'plain' }, 'POST', '/api/control/devices')
    .route({ outputStructure: 'detailed' })
    .input(DevicesBody)
    .output(v.object({ headers: PollHeaders, body: DevicesResponse })),
  uploadMessages: route(DAEMON, 'POST', '/api/control/messages')
    .input(UploadBody)
    .output(UploadResponse),
  pendingSms: route(DAEMON, 'GET', '/api/control/pending-sms')
    .route({ inputStructure: 'detailed', outputStructure: 'detailed' })
    .input(v.object({ headers: PendingSmsHeaders }))
    .output(v.object({ headers: PollHeaders, body: PendingSmsResponse })),
  smsResult: route(DAEMON, 'POST', '/api/control/sms-result')
    .input(SmsResultBody)
    .output(SmsResultResponse),
  // The call reports refuse in { error }; a ring while another call is active answers
  // 409 { ok: false, reason }, which the daemon expects.
  callIncoming: route({ kind: 'daemon', errors: 'plain' }, 'POST', '/api/control/calls/incoming')
    .input(IncomingCallBody)
    .output(IncomingCallResponse),
  callEnded: route({ kind: 'daemon', errors: 'plain' }, 'POST', '/api/control/calls/ended')
    .input(EndedCallBody)
    .output(EndedCallResponse),
};
