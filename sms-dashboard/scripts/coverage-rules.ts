export interface Coverage {
  lines: number;
  functions: number;
}

function sum(lcov: string, key: string): number {
  return [...lcov.matchAll(new RegExp(`^${key}:(\\d+)$`, 'gm'))].reduce(
    (total, match) => total + Number(match[1]),
    0,
  );
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : Math.round((10_000 * hit) / found) / 100;
}

// Bun's text table averages per-file percentages; a large untested file counts as
// much as a one-liner there. These totals weight every line and function equally.
export function lcovTotals(lcov: string): Coverage {
  if (!/^SF:/m.test(lcov)) throw new Error('lcov report has no coverage records');
  return {
    lines: percent(sum(lcov, 'LH'), sum(lcov, 'LF')),
    functions: percent(sum(lcov, 'FNH'), sum(lcov, 'FNF')),
  };
}

export function coverageViolations(suite: string, actual: Coverage, floor: Coverage): string[] {
  return (['lines', 'functions'] as const)
    .filter((metric) => actual[metric] < floor[metric])
    .map(
      (metric) =>
        `${suite} ${metric} ${String(actual[metric])}% is below the floor of ${String(floor[metric])}%.`,
    );
}
