const ACTIVE_QUERY_STATUSES = new Set([
  'queued', 'awaiting_response', 'skill_pending', 'skill_processing',
  'web_pending', 'web_processing', 'web_otp', 'web_authenticating',
  'web_querying', 'web_human_required',
]);

/** The fields polling decisions read off a balance check. */
export interface PollableCheck {
  id: string;
  display_status?: string | null;
  status?: string | null;
  [column: string]: unknown;
}

export function activeBalanceCheckIds(checks: PollableCheck[] = []): string[] {
  return checks
    .filter(isActiveBalanceCheck)
    .map((check) => check.id);
}

export function isActiveBalanceCheck(check: PollableCheck | null | undefined): boolean {
  return ACTIVE_QUERY_STATUSES.has(String(check?.display_status || check?.status || ''));
}

export function balancePollDelay(now: number, fastUntil: number): number {
  return now < fastUntil ? 2_000 : 5_000;
}
