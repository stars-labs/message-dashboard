import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type { D1, D1Batch, D1RunResult, D1Statement } from '../server/lib/d1.js';

function binding(value: unknown): SQLQueryBindings {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new TypeError(`D1 cannot bind a ${typeof value}`);
}

/**
 * The D1 port backed by an in-memory SQLite database, so tests run the real
 * SQL. Statements bind like D1's: every bind returns a new statement.
 */
export function sqliteD1(db: Database = new Database(':memory:')): D1 & D1Batch & { db: Database } {
  // Bun's run().changes also counts rows written by triggers; D1 reports
  // SQLite's changes(), the rows the statement itself changed.
  function statementChanges(): number {
    return v.parse(v.object({ changes: v.number() }), db.query('SELECT changes() AS changes').get())
      .changes;
  }

  function statement(sql: string, params: SQLQueryBindings[]): D1Statement {
    return {
      bind: (...values) => statement(sql, values.map(binding)),
      all: () => Promise.resolve({ results: db.query(sql).all(...params) }),
      first: () => Promise.resolve(db.query(sql).get(...params)),
      run: () => {
        const { lastInsertRowid } = db.query(sql).run(...params);
        return Promise.resolve({
          meta: { changes: statementChanges(), last_row_id: Number(lastInsertRowid) },
        });
      },
    };
  }

  return {
    db,
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      db.run('BEGIN');
      try {
        const results: D1RunResult[] = [];
        for (const each of statements) results.push(await each.run());
        db.run('COMMIT');
        return results;
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    },
  };
}
