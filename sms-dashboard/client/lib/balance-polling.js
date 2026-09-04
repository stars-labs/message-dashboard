const ACTIVE_QUERY_STATUSES = new Set([
  'queued', 'awaiting_response', 'skill_pending', 'skill_processing',
  'web_pending', 'web_processing', 'web_otp', 'web_authenticating',
  'web_querying', 'web_human_required',
]);

export function activeBalanceCheckIds(checks = []) {
  return checks
    .filter(isActiveBalanceCheck)
    .map((check) => check.id);
}

export function isActiveBalanceCheck(check) {
  return ACTIVE_QUERY_STATUSES.has(check?.display_status || check?.status);
}

export function balancePollDelay(now, fastUntil) {
  return now < fastUntil ? 2_000 : 5_000;
}
