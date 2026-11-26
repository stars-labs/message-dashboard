import * as v from 'valibot';
import { splitStatements } from './d1-sql.ts';
import { rehearse, type Rehearsal } from './d1-rehearsal.ts';
import { limitViolations, touchedTables } from './migration-apply-rules.ts';

// About 50 days of the Worker's normal writes, and the free plan's daily read allowance.
// A bigger migration is batched across quota windows, or raised explicitly.
export const REHEARSAL_OPTIONS = {
  'max-rows-read': { type: 'string', default: '5000000' },
  'max-rows-written': { type: 'string', default: '50000' },
} as const;

const Count = v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(0));

export async function rehearseFile(
  file: string,
  options: { 'max-rows-read': string; 'max-rows-written': string },
): Promise<{ rehearsal: Rehearsal; tables: string[]; violations: string[] }> {
  const statements = splitStatements(await Bun.file(file).text());
  const tables = touchedTables(statements);
  const rehearsal = await rehearse(statements, tables);
  const violations = limitViolations(rehearsal, {
    maxRowsRead: v.parse(Count, options['max-rows-read']),
    maxRowsWritten: v.parse(Count, options['max-rows-written']),
  });
  return { rehearsal, tables, violations };
}

export function rehearsalReport(file: string, rehearsal: Rehearsal): string {
  const tables = Object.keys({ ...rehearsal.counts.before, ...rehearsal.counts.after }).sort();
  return [
    `Rehearsed ${file} on a copy of production (${new Date().toISOString()}):`,
    `  rows read ${String(rehearsal.rowsRead)}, rows written ${String(rehearsal.rowsWritten)}`,
    ...tables.map(
      (table) =>
        `  ${table}: ${String(rehearsal.counts.before[table] ?? 0)} → ${String(rehearsal.counts.after[table] ?? 0)} rows`,
    ),
  ].join('\n');
}
