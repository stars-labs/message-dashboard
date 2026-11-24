import type { PageIssue } from '../page-report.ts';

interface JourneyOutcome {
  error: string | null;
  pages: { label: string; issues: PageIssue[] }[];
  /** Screenshots, trace or cleanup that failed after the journey: its evidence may be incomplete. */
  teardown?: string[];
}

/** A journey passes only when it finished, no page it opened logged a problem, and teardown completed. */
export function verdict(outcome: JourneyOutcome): { ok: boolean; failures: string[] } {
  const failures = [
    ...(outcome.error === null ? [] : [`journey: ${outcome.error}`]),
    ...outcome.pages.flatMap(({ label, issues }) =>
      issues.map((issue) => `${label} ${issue.kind}: ${issue.text}`),
    ),
    ...(outcome.teardown ?? []).map((failure) => `teardown: ${failure}`),
  ];
  return { ok: failures.length === 0, failures };
}
