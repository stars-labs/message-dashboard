import { DaemonStatusResponse } from '../daemon-status.js';
import { HealthResponse, LiveResponse } from '../health.js';
import { route } from './route.js';

export const health = {
  live: route({ kind: 'public' }, 'GET', '/api/live').output(LiveResponse),
  ready: route({ kind: 'public' }, 'GET', '/api/health').output(HealthResponse),
  daemonStatus: route(
    { kind: 'user', permission: 'messages.read' },
    'GET',
    '/api/daemon/status',
  ).output(DaemonStatusResponse),
};
