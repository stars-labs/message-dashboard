/** sim_balance_checks.status, as the table's CHECK constraint lists it. */
export const CHECK_STATUSES = [
  'queued',
  'awaiting_response',
  'response_received',
  'parsed',
  'failed',
  'timed_out',
  'unparsed',
] as const;

/** The sim_balance_web_jobs statuses of a job a runner holds. */
export const ACTIVE_WEB_JOB_STATUSES = [
  'leased',
  'awaiting_otp',
  'authenticating',
  'querying',
  'human_verification_required',
] as const;

/** sim_balance_web_jobs.status, as the table's CHECK constraint lists it. */
export const WEB_JOB_STATUSES = [
  'pending',
  ...ACTIVE_WEB_JOB_STATUSES,
  'completed',
  'failed',
  'stopped',
] as const;

/** sim_balance_skill_jobs.status, as the table's CHECK constraint lists it. */
export const SKILL_JOB_STATUSES = ['pending', 'leased', 'completed', 'stopped'] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type ActiveWebJobStatus = (typeof ACTIVE_WEB_JOB_STATUSES)[number];
export type WebJobStatus = (typeof WEB_JOB_STATUSES)[number];
export type SkillJobStatus = (typeof SKILL_JOB_STATUSES)[number];
