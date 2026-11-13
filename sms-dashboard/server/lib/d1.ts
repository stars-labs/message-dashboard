import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';

interface StatementOperations {
  all(): Promise<{ results: unknown[] }>;
  first(): Promise<unknown>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export type D1Operation = keyof StatementOperations;

/**
 * The part of a D1 prepared statement a caller uses. Code names the operations
 * it needs, e.g. `D1<'all' | 'first'>`, so the real binding satisfies the type
 * and a test double implements exactly those operations.
 */
export type D1Statement<Op extends D1Operation = D1Operation> = Pick<StatementOperations, Op> & {
  bind(...values: unknown[]): D1Statement<Op>;
};

export interface D1<Op extends D1Operation = D1Operation> {
  prepare(query: string): D1Statement<Op>;
}

/** D1 returns untyped rows; every read goes through a row schema so a schema drift throws instead of leaking. */
export async function queryAll<T>(
  statement: Pick<StatementOperations, 'all'>,
  row: Schema<T>,
): Promise<T[]> {
  const { results } = await statement.all();
  return v.parse(v.array(row), results);
}

export async function queryFirst<T>(
  statement: Pick<StatementOperations, 'first'>,
  row: Schema<T>,
): Promise<T | null> {
  const result = await statement.first();
  return result === null ? null : v.parse(row, result);
}
