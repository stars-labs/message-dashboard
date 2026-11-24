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

/**
 * The status the dashboard shows for a check: its own status, or the stage of
 * the skill or web job working on it.
 */
export const DISPLAY_STATUSES = [
  ...CHECK_STATUSES,
  'skill_pending',
  'skill_processing',
  'web_pending',
  'web_processing',
  'web_otp',
  'web_authenticating',
  'web_querying',
  'web_human_required',
] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];
export type ActiveWebJobStatus = (typeof ACTIVE_WEB_JOB_STATUSES)[number];
export type WebJobStatus = (typeof WEB_JOB_STATUSES)[number];
export type SkillJobStatus = (typeof SKILL_JOB_STATUSES)[number];
