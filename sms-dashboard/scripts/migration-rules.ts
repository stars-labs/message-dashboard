export interface MigrationFile {
  name: string;
  sql: string;
}

const NEW_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

const THROUGH = /^-- through: (\d{3})$/m;

function migrationNumber(name: string): number {
  const digits = /^\d+/.exec(name);
  if (!digits) throw new Error(`${name} does not start with a migration number`);
  return Number(digits[0]);
}

function threeDigits(value: number): string {
  return String(value).padStart(3, '0');
}

function highestNumber(files: readonly MigrationFile[]): number {
  return Math.max(...files.map((file) => migrationNumber(file.name)));
}

// Production's schema and the reference data only migrations write, as exported.
export const BASELINE_FILES = ['schema.sql', 'reference-data.sql'];

export function isMigration(name: string): boolean {
  return name.endsWith('.sql') && !BASELINE_FILES.includes(name);
}

// schema.sql is production's schema; its header names the last migration it includes.
export function baselineThrough(schemaSql: string): number {
  const match = THROUGH.exec(schemaSql);
  if (!match) throw new Error('schema.sql must say which migration it is through: -- through: NNN');
  return Number(match[1]);
}

export function baselineViolations(through: number, applied: readonly MigrationFile[]): string[] {
  const highest = highestNumber(applied);
  return through < highest
    ? [
        `schema.sql is through ${threeDigits(through)}, but main has migrations up to ${threeDigits(highest)}; regenerate it from production.`,
      ]
    : [];
}

export function pendingMigrations(names: readonly string[], through: number): string[] {
  return names
    .filter((name) => isMigration(name) && migrationNumber(name) > through)
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b));
}

// The files that build production's database before any user data, in order.
export function databaseFiles(names: readonly string[], through: number): string[] {
  return [...BASELINE_FILES, ...pendingMigrations(names, through)];
}

// `applied` is what main holds: production runs a migration only once it reaches main.
// Its historical duplicate numbers stay; only migrations added since are held to a number.
export function migrationViolations(
  applied: readonly MigrationFile[],
  current: readonly MigrationFile[],
): string[] {
  const violations: string[] = [];
  const currentByName = new Map(current.map((file) => [file.name, file]));

  for (const file of applied) {
    const now = currentByName.get(file.name);
    if (!now) {
      violations.push(`${file.name} was removed; an applied migration stays.`);
    } else if (now.sql !== file.sql) {
      violations.push(`${file.name} changed; an applied migration is never edited, add a new one.`);
    }
  }

  const appliedNames = new Set(applied.map((file) => file.name));
  const highest = highestNumber(applied);
  const claimed = new Map<number, string>();

  for (const file of current) {
    if (appliedNames.has(file.name)) continue;
    const match = NEW_NAME.exec(file.name);
    if (!match) {
      violations.push(`${file.name} must be named NNN_snake_case.sql.`);
      continue;
    }
    const number = Number(match[1]);
    if (number <= highest) {
      violations.push(`${file.name} must be numbered above ${threeDigits(highest)}.`);
      continue;
    }
    const earlier = claimed.get(number);
    if (earlier) {
      violations.push(`${file.name} reuses number ${threeDigits(number)} (${earlier}).`);
      continue;
    }
    claimed.set(number, file.name);
  }

  return violations;
}
