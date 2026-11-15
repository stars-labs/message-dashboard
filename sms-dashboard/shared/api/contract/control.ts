import * as v from 'valibot';
import {
  CleanupBody,
  CleanupResponse,
  ClearMessagesResponse,
  DevicesBody,
  DevicesResponse,
  PendingSmsHeaders,
  PendingSmsResponse,
  SmsResultBody,
  SmsResultResponse,
  UploadBody,
  UploadResponse,
} from '../daemon.js';
import { route } from './route.js';

/** The daemon's API key; the route refuses in { success: false, error }. */
const DAEMON = { kind: 'daemon', errors: 'flagged' } as const;

export const HeartbeatResponse = v.object({
  success: v.literal(true),
  message: v.string(),
  received_at: v.string(),
});

export type HeartbeatResponse = v.InferOutput<typeof HeartbeatResponse>;

/**
 * The routes the Pi daemon calls. Their wire format is pinned by
 * shared/control-fixtures/, which the daemon is tested against too.
 */
export const control = {
  // The snapshot is read field by field (normalizeHealthSnapshot), so a daemon
  // a version ahead or behind gets the refusal it always got.
  heartbeat: route(DAEMON, 'POST', '/api/control/heartbeat')
    .input(v.unknown())
    .output(HeartbeatResponse),
  // The one route that refuses a report in { error }, as it always has.
  devices: route({ kind: 'daemon', errors: 'plain' }, 'POST', '/api/control/devices')
    .input(DevicesBody)
    .output(DevicesResponse),
  uploadMessages: route(DAEMON, 'POST', '/api/control/messages')
    .input(UploadBody)
    .output(UploadResponse),
  clearMessages: route(DAEMON, 'DELETE', '/api/control/messages').output(ClearMessagesResponse),
  cleanupTestData: route(DAEMON, 'POST', '/api/control/cleanup-test-data')
    .input(CleanupBody)
    .output(CleanupResponse),
  pendingSms: route(DAEMON, 'GET', '/api/control/pending-sms')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ headers: PendingSmsHeaders }))
    .output(PendingSmsResponse),
  smsResult: route(DAEMON, 'POST', '/api/control/sms-result')
    .input(SmsResultBody)
    .output(SmsResultResponse),
};
