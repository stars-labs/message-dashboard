import * as v from 'valibot';
import { route } from './route.js';

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
  heartbeat: route({ kind: 'daemon' }, 'POST', '/api/control/heartbeat')
    .input(v.unknown())
    .output(HeartbeatResponse),
};
