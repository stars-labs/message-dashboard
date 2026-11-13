import * as v from 'valibot';
import type { Schema } from '../../shared/parse-json.js';

/** D1 returns untyped rows; every read goes through a row schema so a schema drift throws instead of leaking. */
export async function queryAll<T>(
  statement: { all(): Promise<{ results: unknown[] }> },
  row: Schema<T>,
): Promise<T[]> {
  const { results } = await statement.all();
  return v.parse(v.array(row), results);
}

export async function queryFirst<T>(
  statement: { first(): Promise<unknown> },
  row: Schema<T>,
): Promise<T | null> {
  const result = await statement.first();
  return result === null ? null : v.parse(row, result);
}
