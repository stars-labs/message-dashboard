// Every call that recurs on a schedule, and how often (ADR 0002). This is the only place
// an interval is written down: the Worker sends `everySeconds` to the daemon and the
// Balance Agent in X-Poll-Interval, the dashboard imports it, and a test holds
// wrangler.toml's cron schedule to it. server/recurring-calls.test.ts multiplies the
// idle calls out against the free plan.

/** The callers a recurring call serves at most. */
export const CALLERS = {
  /** The Orange Pi. */
  daemon: 1,
  /** Balance Agent installations: 3 registered on 2026-11-26. */
  runners: 3,
  /** Open dashboard tabs: the Worker cannot see them, so ADR 0002 sets it. */
  tabs: 5,
  worker: 1,
} as const;

export type RecurringCall = {
  everySeconds: number;
  callers: number;
  /**
   * Whether it runs with nothing to do. Idle calls count against the daily budget;
   * the others run only while work is in progress and read in proportion to it.
   */
  idle: boolean;
} & ({ procedure: string } | { cron: string });

export const RECURRING = {
  daemonPendingSms: {
    procedure: 'control.pendingSms',
    everySeconds: 10,
    callers: CALLERS.daemon,
    idle: true,
  },
  daemonDevices: {
    procedure: 'control.devices',
    everySeconds: 30,
    callers: CALLERS.daemon,
    idle: true,
  },
  daemonHeartbeat: {
    procedure: 'control.heartbeat',
    everySeconds: 60,
    callers: CALLERS.daemon,
    idle: true,
  },
  runnerSkillClaim: {
    procedure: 'balanceSkillJobs.claim',
    everySeconds: 5,
    callers: CALLERS.runners,
    idle: true,
  },
  runnerWebClaim: {
    procedure: 'carrierWebJobs.claim',
    everySeconds: 5,
    callers: CALLERS.runners,
    idle: true,
  },
  runnerHeartbeat: {
    procedure: 'balanceRunnerControl.heartbeat',
    everySeconds: 30,
    callers: CALLERS.runners,
    idle: true,
  },
  dashboardMessages: {
    procedure: 'messages.list',
    everySeconds: 60,
    callers: CALLERS.tabs,
    idle: true,
  },
  dashboardDaemonStatus: {
    procedure: 'health.daemonStatus',
    everySeconds: 300,
    callers: CALLERS.tabs,
    idle: true,
  },
  dashboardRunnerStatus: {
    procedure: 'balanceRunners.status',
    everySeconds: 30,
    callers: CALLERS.tabs,
    idle: true,
  },
  dashboardCallState: {
    procedure: 'calls.state',
    everySeconds: 10,
    callers: CALLERS.tabs,
    idle: true,
  },
  dashboardLiveCallState: {
    procedure: 'calls.state',
    everySeconds: 3,
    callers: CALLERS.tabs,
    idle: false,
  },
  dashboardBatchProgress: {
    procedure: 'balanceBatches.list',
    everySeconds: 10,
    callers: CALLERS.tabs,
    idle: false,
  },
  dashboardBalanceStatus: {
    procedure: 'balanceChecks.status',
    everySeconds: 5,
    callers: CALLERS.tabs,
    idle: false,
  },
  dashboardBalanceStatusFast: {
    procedure: 'balanceChecks.status',
    everySeconds: 2,
    callers: CALLERS.tabs,
    idle: false,
  },
  cronMaintenance: {
    cron: '*/5 * * * *',
    everySeconds: 300,
    callers: CALLERS.worker,
    idle: true,
  },
  cronNightly: {
    cron: '17 4 * * *',
    everySeconds: 86_400,
    callers: CALLERS.worker,
    idle: true,
  },
} as const satisfies Record<string, RecurringCall>;

export type RecurringName = keyof typeof RECURRING;

export const POLL_INTERVAL_HEADER = 'X-Poll-Interval';

export function intervalMs(name: RecurringName): number {
  return RECURRING[name].everySeconds * 1000;
}
