// bun run check:coverage: the lcov reports `bun run test` and the Balance Agent's
// `bun run test` write, against the floors below. Raise a floor when coverage rises;
// never lower one to make a change pass.
import { join } from 'node:path';
import { coverageViolations, lcovTotals, type Coverage } from './coverage-rules.ts';

const root = join(import.meta.dirname, '..');

const FLOORS: Record<string, { report: string; floor: Coverage }> = {
  runtime: { report: 'coverage/runtime/lcov.info', floor: { lines: 99.3, functions: 99.5 } },
  client: { report: 'coverage/client/lcov.info', floor: { lines: 86.1, functions: 83.8 } },
  agent: { report: 'balance-agent/coverage/lcov.info', floor: { lines: 64.8, functions: 61.8 } },
};

const violations: string[] = [];
for (const [suite, { report, floor }] of Object.entries(FLOORS)) {
  const file = Bun.file(join(root, report));
  if (!(await file.exists()))
    throw new Error(`${report} is missing; run the ${suite} tests first.`);
  const actual = lcovTotals(await file.text());
  console.log(`${suite}: lines ${String(actual.lines)}%, functions ${String(actual.functions)}%`);
  violations.push(...coverageViolations(suite, actual, floor));
}

if (violations.length > 0) {
  console.error(`Coverage fell:\n${violations.join('\n')}`);
  process.exit(1);
}
