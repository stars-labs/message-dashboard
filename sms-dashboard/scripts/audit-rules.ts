export interface Advisory {
  ghsa: string;
  pkg: string;
  severity: string;
  title: string;
}

// Every reported advisory must be accepted with a reason, and every accepted one
// must still be reported, so the list only holds what is true today.
export function auditViolations(
  reported: readonly Advisory[],
  accepted: Readonly<Record<string, string>>,
): string[] {
  const unaccepted = new Map(
    reported
      .filter((advisory) => !(advisory.ghsa in accepted))
      .map((advisory) => [advisory.ghsa, advisory]),
  );
  const reportedIds = new Set(reported.map((advisory) => advisory.ghsa));

  return [
    ...[...unaccepted.values()].map(
      ({ ghsa, pkg, severity, title }) => `${severity} ${pkg} ${ghsa}: ${title}`,
    ),
    ...Object.keys(accepted)
      .filter((ghsa) => !reportedIds.has(ghsa))
      .map((ghsa) => `${ghsa} is accepted but no longer reported; remove it from ACCEPTED.`),
  ];
}
