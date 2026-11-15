// The request object the router hands to route handlers. Env is the global
// interface wrangler types generates (worker-configuration.d.ts), with the
// secrets merged in by secrets-env.d.ts.
//
// Types-only module: every export is erased at runtime.

import type { SessionUser } from '../shared/api/auth.js';
import type { D1, D1Batch } from './lib/d1.js';
import type { KV } from './lib/kv.js';

/**
 * The bindings the app uses, as the operations it calls: the runtime's Env
 * satisfies it, and tests build one from in-memory doubles.
 */
export type AppEnv = Omit<Env, 'DB' | 'SESSIONS' | 'CALL_STATE'> & {
  DB: D1 & D1Batch;
  SESSIONS: KV;
  CALL_STATE: {
    getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> };
  };
};

/** The part of the runtime's ExecutionContext the app uses. */
export interface AppContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The Request handlers receive: the Worker's request with the env and ctx the
 * runtime passed alongside it, and the route parameters and caller the router
 * and the auth middleware add.
 */
export interface AppRequest extends Request {
  env: AppEnv;
  ctx: AppContext;
  params?: Record<string, string>;
  user?: SessionUser & { permissions?: string[] };
  auth0Token?: Record<string, unknown>;
}
