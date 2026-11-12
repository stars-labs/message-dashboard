// Worker bindings and the request object the middleware hands to handlers.
//
// Types-only module: every export is erased at runtime. Import it with
// `import type { Env } from '../shared/worker-context.js'`.

import type {
  D1Database,
  KVNamespace,
  DurableObjectNamespace,
  ExecutionContext,
} from './cf-bindings.js';

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  CALL_STATE: DurableObjectNamespace;

  // Shared secret the Orange Pi daemon authenticates with. Never Auth0.
  API_KEY?: string;

  AUTH0_DOMAIN?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  AUTH0_AUDIENCE?: string;
  AUTH0_LOGIN_AUDIENCE?: string;
  AUTH0_M2M_CLIENT_ID?: string;
  AUTH0_M2M_CLIENT_SECRET?: string;
  AUTH0_ADMIN_ROLE?: string;
  AUTH0_VIEWER_ROLE?: string;
  AUTH0_ROLE_NAMESPACE?: string;

  ENVIRONMENT?: string;
  WORKER_URL?: string;
  API_BASE_URL?: string;
  ALLOWED_EMAIL_DOMAINS?: string;

  // Cloudflare Realtime, used by voice calls (server/api/calls.js).
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  VOICE_BRIDGE_HOST?: string;
}

/** The caller as the middleware builds it. `roles` is always present. */
export interface RequestUser {
  id: string;
  email?: string;
  name?: string;
  picture?: string;
  roles: string[];
  permissions?: string[];
}

/** A route handler. Returning a Response short-circuits; null/undefined continues. */
export type Handler = (
  request: AppRequest,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response | null | undefined> | Response | null | undefined;

/**
 * The Request handlers actually receive. `env` and `ctx` are also passed as
 * arguments; they are mirrored here because the router sets them before the
 * first handler runs, and audit-log.js reads request.ctx.
 */
export interface AppRequest extends Request {
  env: Env;
  ctx: ExecutionContext;
  params?: Record<string, string>;
  user?: RequestUser;
  auth0Token?: Record<string, unknown>;
}