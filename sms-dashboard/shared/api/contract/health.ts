import { DaemonStatusResponse } from '../daemon-status.js';
import { HealthResponse, LiveResponse } from '../health.js';
import { route } from './route.js';

/** Liveness and readiness for uptime monitors, and the daemon's state for the dashboard. */
export const health = {
  live: route({ kind: 'public' }, 'GET', '/api/live').output(LiveResponse),
  ready: route({ kind: 'public' }, 'GET', '/api/health').output(HealthResponse),
  daemonStatus: route(
    { kind: 'user', permission: 'messages.read' },
    'GET',
    '/api/daemon/status',
  ).output(DaemonStatusResponse),
};
