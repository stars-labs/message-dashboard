// Every call that recurs on a schedule, and how often (ADR 0002). The Worker sends
// `everySeconds` to the daemon and the Balance Agent in X-Poll-Interval; the budget
// test in server/recurring-calls.test.ts multiplies it out against the free plan.

/** The callers a recurring call serves at most. */
export const CALLERS = {
  /** The Orange Pi. */
  daemon: 1,
  /** Balance Agent installations: 3 registered on 2026-11-26. */
  runners: 3,
} as const;

export interface RecurringCall {
  /** The contract procedure, as `group.name`. */
  procedure: string;
  everySeconds: number;
  callers: number;
}

export const RECURRING = {
  daemonPendingSms: { procedure: 'control.pendingSms', everySeconds: 10, callers: CALLERS.daemon },
  daemonDevices: { procedure: 'control.devices', everySeconds: 30, callers: CALLERS.daemon },
  daemonHeartbeat: { procedure: 'control.heartbeat', everySeconds: 60, callers: CALLERS.daemon },
  runnerSkillClaim: {
    procedure: 'balanceSkillJobs.claim',
    everySeconds: 5,
    callers: CALLERS.runners,
  },
  runnerWebClaim: { procedure: 'carrierWebJobs.claim', everySeconds: 5, callers: CALLERS.runners },
  runnerHeartbeat: {
    procedure: 'balanceRunnerControl.heartbeat',
    everySeconds: 30,
    callers: CALLERS.runners,
  },
} as const satisfies Record<string, RecurringCall>;

export type RecurringName = keyof typeof RECURRING;

export const POLL_INTERVAL_HEADER = 'X-Poll-Interval';
