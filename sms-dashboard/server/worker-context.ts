import type { SessionUser } from '../shared/api/auth.js';
import type { D1, D1Batch } from './lib/d1.js';
import type { KV } from './lib/kv.js';

export type AppEnv = Omit<Env, 'DB' | 'SESSIONS' | 'CALL_STATE'> & {
  DB: D1 & D1Batch;
  SESSIONS: KV;
  CALL_STATE: {
    getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> };
  };
};

export interface AppContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface AppRequest extends Request {
  env: AppEnv;
  ctx: AppContext;
  user?: SessionUser & { permissions?: string[] };
  auth0Token?: Record<string, unknown>;
}
