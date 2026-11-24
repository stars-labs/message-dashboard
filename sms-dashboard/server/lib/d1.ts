import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';

/** D1 rejects a statement with more bound parameters than this. */
export const D1_MAX_BOUND_PARAMETERS = 100;

export interface D1RunResult {
  meta: { changes: number; last_row_id: number };
}

interface StatementOperations {
  all(): Promise<{ results: unknown[] }>;
  first(): Promise<unknown>;
  run(): Promise<D1RunResult>;
}

export type D1Operation = keyof StatementOperations;

// Callers name the operations they use, e.g. `D1<'all' | 'first'>`, so a test double
// implements only those.
export type D1Statement<Op extends D1Operation = D1Operation> = Pick<StatementOperations, Op> & {
  bind(...values: unknown[]): D1Statement<Op>;
};

export interface D1<Op extends D1Operation = D1Operation> {
  prepare(query: string): D1Statement<Op>;
}

// Statements run as one transaction.
export interface D1Batch<Op extends D1Operation = D1Operation> {
  batch(statements: D1Statement<Op>[]): Promise<D1RunResult[]>;
}

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

export async function queryOne<T>(
  statement: Pick<StatementOperations, 'first'>,
  row: Schema<T>,
): Promise<T> {
  const result = await queryFirst(statement, row);
  if (result === null) throw new Error('Statement returned no row');
  return result;
}
