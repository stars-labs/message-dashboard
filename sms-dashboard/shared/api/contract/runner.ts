import * as v from 'valibot';
import {
  RunnerCheckResponse,
  RunnerHeartbeatBody,
  RunnerHeartbeatResponse,
} from '../balance-runners.js';
import {
  BalanceSkillJob,
  SkillDecisionBody,
  SkillDecisionResponse,
  SkillReleaseBody,
} from '../balance-skill-jobs.js';
import { JobParams, RunnerIdQuery } from '../runner-jobs.js';
import { RUNNER_SCOPES } from '../runner-scopes.js';
import { route } from './route.js';

// The routes the Balance Agent calls. It is a desktop app already shipped, so
// their wire format is pinned by shared/control-fixtures/runner/, which the
// Agent is tested against too.

const PRESENCE = { kind: 'runner', scope: RUNNER_SCOPES.heartbeat } as const;

const SMS_AI = { kind: 'runner', scope: RUNNER_SCOPES.smsAi } as const;

/** The SMS menu replies the Agent's company AI decides on, one leased job at a time. */
export const balanceSkillJobs = {
  // 204: no job is waiting for this runner's account.
  claim: route(SMS_AI, 'GET', '/api/control/balance-skills/jobs/claim')
    .route({ inputStructure: 'detailed', outputStructure: 'detailed' })
    .input(v.object({ query: RunnerIdQuery }))
    .output(
      v.union([
        v.object({ status: v.literal(200), body: BalanceSkillJob }),
        v.object({ status: v.literal(204) }),
      ]),
    ),
  decision: route(SMS_AI, 'POST', '/api/control/balance-skills/jobs/{id}/decision')
    .route({ inputStructure: 'detailed', outputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: SkillDecisionBody }))
    .output(SkillDecisionResponse),
  release: route(SMS_AI, 'POST', '/api/control/balance-skills/jobs/{id}/release')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: SkillReleaseBody }))
    .output(v.object({ success: v.literal(true) })),
};

/** The Agent's sign-in check and its presence. */
export const balanceRunnerControl = {
  check: route(PRESENCE, 'GET', '/api/control/balance-runners/check').output(RunnerCheckResponse),
  heartbeat: route(PRESENCE, 'POST', '/api/control/balance-runners/heartbeat')
    .input(RunnerHeartbeatBody)
    .output(RunnerHeartbeatResponse),
};
