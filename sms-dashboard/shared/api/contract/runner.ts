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
import {
  CarrierWebBalanceJobWire,
  CarrierWebBalanceOtpWire,
  WebJobActionResponse,
  WebJobCompleteBody,
  WebJobErrorBody,
  WebJobHeartbeatBody,
  WebJobHeartbeatResponse,
  WebJobLeaseBody,
  WebJobOtpQuery,
} from '../carrier-web-balance.js';
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

const BROWSER = { kind: 'runner', scope: RUNNER_SCOPES.carrierBrowser } as const;

const WEB_JOBS = '/api/control/carrier-web-balance/jobs';

/** The carrier portal queries the Agent runs in a browser, one leased job at a time. */
export const carrierWebJobs = {
  // 204: no job is waiting for this runner's account.
  claim: route(BROWSER, 'GET', `${WEB_JOBS}/claim`)
    .route({ inputStructure: 'detailed', outputStructure: 'detailed' })
    .input(v.object({ query: RunnerIdQuery }))
    .output(
      v.union([
        v.object({ status: v.literal(200), body: CarrierWebBalanceJobWire }),
        v.object({ status: v.literal(204) }),
      ]),
    ),
  otpRequested: route(BROWSER, 'POST', `${WEB_JOBS}/{id}/otp-requested`)
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: WebJobLeaseBody }))
    .output(WebJobActionResponse),
  // 204: no code has arrived since the OTP was requested.
  otp: route(BROWSER, 'GET', `${WEB_JOBS}/{id}/otp`)
    .route({ inputStructure: 'detailed', outputStructure: 'detailed' })
    .input(v.object({ params: JobParams, query: WebJobOtpQuery }))
    .output(
      v.union([
        v.object({ status: v.literal(200), body: CarrierWebBalanceOtpWire }),
        v.object({ status: v.literal(204) }),
      ]),
    ),
  heartbeat: route(BROWSER, 'POST', `${WEB_JOBS}/{id}/heartbeat`)
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: WebJobHeartbeatBody }))
    .output(WebJobHeartbeatResponse),
  complete: route(BROWSER, 'POST', `${WEB_JOBS}/{id}/complete`)
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: WebJobCompleteBody }))
    .output(WebJobActionResponse),
  fail: route(BROWSER, 'POST', `${WEB_JOBS}/{id}/fail`)
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: WebJobErrorBody }))
    .output(WebJobActionResponse),
  release: route(BROWSER, 'POST', `${WEB_JOBS}/{id}/release`)
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: JobParams, body: WebJobErrorBody }))
    .output(WebJobActionResponse),
};

/** The Agent's sign-in check and its presence. */
export const balanceRunnerControl = {
  check: route(PRESENCE, 'GET', '/api/control/balance-runners/check').output(RunnerCheckResponse),
  heartbeat: route(PRESENCE, 'POST', '/api/control/balance-runners/heartbeat')
    .input(RunnerHeartbeatBody)
    .output(RunnerHeartbeatResponse),
};
