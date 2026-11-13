// Minimal Cloudflare Workers binding types.
//
// @cloudflare/workers-types would supply these, but it is not a dependency of
// this repo and the Worker bundles with wrangler regardless. These are the only
// globals the server code touches; widening them means adding a member here
// rather than installing a package.
//
// Types-only module: nothing is emitted.

/** The subset of D1 used by this Worker. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id?: number } }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
  exec(query: string): Promise<{ count: number }>;
}

/** The subset of KV used by this Worker. */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, options: { type: 'json' }): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A Durable Object namespace, keyed by name. */
export interface DurableObjectNamespace {
  getByName(name: string): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
}

/** Cloudflare's execution context, as passed to fetch and scheduled. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}