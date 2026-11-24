import type { PageIssue } from '../page-report.ts';

interface JourneyOutcome {
  error: string | null;
  pages: { label: string; issues: PageIssue[] }[];
}

/** A journey passes only when it finished and no page it opened logged a problem. */
export function verdict(outcome: JourneyOutcome): { ok: boolean; failures: string[] } {
  const failures = [
    ...(outcome.error === null ? [] : [`journey: ${outcome.error}`]),
    ...outcome.pages.flatMap(({ label, issues }) =>
      issues.map((issue) => `${label} ${issue.kind}: ${issue.text}`),
    ),
  ];
  return { ok: failures.length === 0, failures };
}
