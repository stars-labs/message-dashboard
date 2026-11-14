// The request object the router hands to route handlers. Env is the global
// interface wrangler types generates (worker-configuration.d.ts), with the
// secrets merged in by secrets-env.d.ts.
//
// Types-only module: every export is erased at runtime.

import type { SessionUser } from '../shared/api/auth.js';

/**
 * The Request handlers receive: the Worker's request with the env and ctx the
 * runtime passed alongside it, and the route parameters and caller the router
 * and the auth middleware add.
 */
export interface AppRequest extends Request {
  env: Env;
  ctx: ExecutionContext;
  params?: Record<string, string>;
  user?: SessionUser & { permissions?: string[] };
  auth0Token?: Record<string, unknown>;
}
