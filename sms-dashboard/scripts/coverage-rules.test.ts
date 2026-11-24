import { describe, expect, test } from 'bun:test';
import { coverageViolations, lcovTotals } from './coverage-rules.ts';

const LCOV = `TN:
SF:server/a.ts
FNF:4
FNH:3
DA:1,1
LF:10
LH:9
end_of_record
TN:
SF:server/b.ts
FNF:1
FNH:0
LF:10
LH:1
end_of_record
`;

describe('lcovTotals', () => {
  test('sums lines and functions over every file, weighted by size', () => {
    expect(lcovTotals(LCOV)).toEqual({ lines: 50, functions: 60 });
  });

  test('throws on a report with no files', () => {
    expect(() => lcovTotals('TN:\n')).toThrow('no coverage records');
  });
});

describe('coverageViolations', () => {
  test('accepts totals at or above the floor', () => {
    expect(
      coverageViolations('runtime', { lines: 50, functions: 60 }, { lines: 50, functions: 59.9 }),
    ).toEqual([]);
  });

  test('names each total below its floor', () => {
    expect(
      coverageViolations('client', { lines: 49.95, functions: 60 }, { lines: 50, functions: 61 }),
    ).toEqual([
      'client lines 49.95% is below the floor of 50%.',
      'client functions 60% is below the floor of 61%.',
    ]);
  });
});
