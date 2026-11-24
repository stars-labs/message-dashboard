import type { Database } from 'bun:sqlite';
import * as v from 'valibot';

// The tables whose rows only migrations write, so the baseline carries them.
export const REFERENCE_TABLES = [{ table: 'sim_balance_profiles', key: 'id' }];

const TYPE_ORDER = ['table', 'view', 'index', 'trigger'];

const ObjectRow = v.tuple([v.string(), v.string(), v.nullable(v.string())]);

interface Entry {
  label: string;
  rank: number;
  shown: string;
  compared: string;
}

function collapse(sql: string): string {
  return sql.replaceAll(/\s+/g, ' ').trim();
}

function schemaEntries(db: Database): Entry[] {
  return v
    .parse(
      v.array(ObjectRow),
      db.query(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).values(),
    )
    .flatMap(([type, name, sql]) =>
      sql === null
        ? []
        : [
            {
              label: `${type} ${name}`,
              rank: TYPE_ORDER.indexOf(type),
              shown: collapse(sql),
              compared: collapse(sql).replaceAll(/\s*([(),])\s*/g, '$1'),
            },
          ],
    );
}

function referenceEntries(db: Database): Entry[] {
  return REFERENCE_TABLES.flatMap(({ table, key }, index) => {
    const statement = db.query(`SELECT * FROM ${table} ORDER BY ${key}`);
    const columns = statement.columnNames;
    return statement.values().map((values) => {
      const row = Object.fromEntries(columns.map((column, i) => [column, values[i]]));
      const json = JSON.stringify(row);
      return {
        label: `${table} ${String(row[key])}`,
        rank: TYPE_ORDER.length + index,
        shown: json,
        compared: json,
      };
    });
  });
}

function entries(db: Database): Map<string, Entry> {
  return new Map(
    [...schemaEntries(db), ...referenceEntries(db)].map((entry) => [entry.label, entry]),
  );
}

// What production holds that the baseline (schema.sql + reference-data.sql) does not, and back.
export function schemaDrift(baseline: Database, production: Database): string[] {
  const expected = entries(baseline);
  const actual = entries(production);
  const labels = [...new Set([...expected.keys(), ...actual.keys()])].map((label) => {
    const entry = expected.get(label) ?? actual.get(label);
    if (!entry) throw new Error(`no entry for ${label}`);
    return entry;
  });
  labels.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));

  return labels.flatMap(({ label }) => {
    const want = expected.get(label);
    const have = actual.get(label);
    if (!want) return [`${label} is in production only`];
    if (!have) return [`${label} is in the baseline only`];
    if (want.compared === have.compared) return [];
    return [`${label} differs:\n  baseline:   ${want.shown}\n  production: ${have.shown}`];
  });
}
