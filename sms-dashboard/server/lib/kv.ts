import { parseJson, type Parsed, type Schema } from '../../shared/parse-json.js';

interface KVOperations {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export type KVOperation = keyof KVOperations;

/**
 * The part of a KV namespace a caller uses, e.g. `KV<'get' | 'put'>`. The real
 * binding satisfies it and a test double implements exactly those operations.
 */
export type KV<Op extends KVOperation = KVOperation> = Pick<KVOperations, Op>;

/** Reads a JSON value stored as text: null when the key is absent, otherwise the schema's verdict. */
export async function readKvJson<T>(
  kv: KV<'get'>,
  key: string,
  schema: Schema<T>,
): Promise<Parsed<T> | null> {
  const text = await kv.get(key);
  return text === null ? null : parseJson(text, schema);
}
