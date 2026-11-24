/** The OAuth scopes a Balance Agent asks Auth0 for; each runner route requires one. */
export const RUNNER_SCOPES = Object.freeze({
  heartbeat: 'balance:runners:heartbeat',
  smsAi: 'balance:skills:run',
  carrierBrowser: 'balance:browser:run',
} as const);

export const ALL_RUNNER_SCOPES = [
  RUNNER_SCOPES.heartbeat,
  RUNNER_SCOPES.smsAi,
  RUNNER_SCOPES.carrierBrowser,
] as const;

export type RunnerScope = (typeof ALL_RUNNER_SCOPES)[number];
