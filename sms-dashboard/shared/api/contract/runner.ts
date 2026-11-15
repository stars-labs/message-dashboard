import {
  RunnerCheckResponse,
  RunnerHeartbeatBody,
  RunnerHeartbeatResponse,
} from '../balance-runners.js';
import { RUNNER_SCOPES } from '../runner-scopes.js';
import { route } from './route.js';

// The routes the Balance Agent calls. It is a desktop app already shipped, so
// their wire format is pinned by shared/control-fixtures/runner/, which the
// Agent is tested against too.

const PRESENCE = { kind: 'runner', scope: RUNNER_SCOPES.heartbeat } as const;

/** The Agent's sign-in check and its presence. */
export const balanceRunnerControl = {
  check: route(PRESENCE, 'GET', '/api/control/balance-runners/check').output(RunnerCheckResponse),
  heartbeat: route(PRESENCE, 'POST', '/api/control/balance-runners/heartbeat')
    .input(RunnerHeartbeatBody)
    .output(RunnerHeartbeatResponse),
};
