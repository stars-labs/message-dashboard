import { pendingMigrations } from './migration-rules.ts';

export interface RowCounts {
  rowsRead: number;
  rowsWritten: number;
}

export interface Limits {
  maxRowsRead: number;
  maxRowsWritten: number;
}

export type TableCounts = Record<string, number>;

export interface CountsAround {
  before: TableCounts;
  after: TableCounts;
}

// Migrations reach production in order, one at a time, each right after the baseline.
export function migrationToApply(
  names: readonly string[],
  through: number,
  number: string,
): string {
  const named = names.find((name) => name.startsWith(`${number}_`));
  if (named === undefined) throw new Error(`No migration ${number} in migrations/.`);
  const [next] = pendingMigrations(names, through);
  if (next === undefined || Number(number) <= through) {
    throw new Error(
      `${named} is already in the baseline (through ${String(through).padStart(3, '0')}).`,
    );
  }
  if (next !== named) throw new Error(`${next} comes first: apply migrations in order.`);
  return named;
}

// An export carries no header; the baseline's header, with `through` moved on, goes back on.
export function withBaselineHeader(current: string, exported: string, through: number): string {
  const lines = current.split('\n');
  const end = lines.findIndex((line) => !line.startsWith('--'));
  const header = lines
    .slice(0, end === -1 ? lines.length : end)
    .map((line) =>
      line.startsWith('-- through: ') ? `-- through: ${String(through).padStart(3, '0')}` : line,
    );
  return `${header.join('\n')}\n${exported}`;
}

export function limitViolations(rows: RowCounts, limits: Limits): string[] {
  return [
    ...(rows.rowsRead > limits.maxRowsRead
      ? [
          `The rehearsal read ${String(rows.rowsRead)} rows, above the limit of ${String(limits.maxRowsRead)} (--max-rows-read).`,
        ]
      : []),
    ...(rows.rowsWritten > limits.maxRowsWritten
      ? [
          `The rehearsal wrote ${String(rows.rowsWritten)} rows, above the limit of ${String(limits.maxRowsWritten)} (--max-rows-written).`,
        ]
      : []),
  ];
}

export function parseBookmark(timeTravelInfo: string): string {
  const match = /current bookmark is '([^']+)'/.exec(timeTravelInfo);
  if (match?.[1] === undefined) throw new Error(`No bookmark in:\n${timeTravelInfo}`);
  return match[1];
}

const IDENTIFIER = String.raw`["\`[]?(\w+)["\`\]]?`;
const WRITES = new RegExp(
  String.raw`^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+${IDENTIFIER}`,
  'i',
);
const RENAME = new RegExp(
  String.raw`^\s*ALTER\s+TABLE\s+${IDENTIFIER}\s+RENAME\s+TO\s+${IDENTIFIER}`,
  'i',
);

// The tables whose rows a migration can change, named as they are once it has run.
export function touchedTables(statements: readonly string[]): string[] {
  const tables = new Set<string>();
  for (const statement of statements) {
    const rename = RENAME.exec(statement);
    if (rename?.[1] !== undefined && rename[2] !== undefined) {
      tables.delete(rename[1]);
      tables.add(rename[2]);
      continue;
    }
    const written = WRITES.exec(statement)?.[1];
    if (written !== undefined) tables.add(written);
  }
  return [...tables].sort();
}

export function countChanges(rehearsal: CountsAround, production: CountsAround) {
  const tables = new Set([
    ...Object.keys(production.before),
    ...Object.keys(production.after),
    ...Object.keys(rehearsal.before),
    ...Object.keys(rehearsal.after),
  ]);
  const change = ({ before, after }: CountsAround, table: string) =>
    (after[table] ?? 0) - (before[table] ?? 0);
  return [...tables].sort().map((table) => ({
    table,
    production: change(production, table),
    rehearsal: change(rehearsal, table),
  }));
}
