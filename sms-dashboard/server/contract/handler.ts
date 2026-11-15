import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { StandardOpenAPIMatcher } from '@orpc/openapi/standard';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import {
  ORPCError,
  traverseContractProcedures,
  type AnyRouter,
  type TraverseContractProcedureCallbackOptions,
} from '@orpc/server';
import * as v from 'valibot';
import { contract } from '../../shared/api/contract/index.js';
import { Method, RouteMeta, type Access } from '../../shared/api/contract/route.js';
import { ErrorResponse } from '../../shared/api/error.js';
import { readJson } from '../../shared/parse-json.js';
import { requireApiKey, unauthorized } from '../handlers/control.js';
import { handleAuth0 } from '../middleware/auth0.js';
import { authorize } from '../middleware/authorize.js';
import { enrichUserPermissions } from '../middleware/rbac.js';
import { authorizeRunnerControl, type AuthorizedRunner } from '../utils/runner-auth.js';
import type { AppRequest } from '../worker-context.js';
import { daemonErrorOf, problemOf, problemResponse, type DaemonErrors } from './errors.js';
import { router, type ContractContext } from './router.js';

const JSON_TYPE = 'application/json;charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json';

const RefusalBody = v.object({ ...ErrorResponse.entries, message: v.optional(v.string()) });

/** A 401/403 from the Auth0 + RBAC gate, as a problem. */
async function asProblem(refused: Response): Promise<Response> {
  const body = await readJson(refused, RefusalBody);
  const detail = body.ok ? (body.value.message ?? body.value.error) : refused.statusText;
  const code = refused.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED';
  return problemResponse(refused.status, code, detail);
}

type Admission = { refused: Response } | { refused: null; runner: AuthorizedRunner | null };

const ADMITTED: Admission = { refused: null, runner: null };

/**
 * Whether the route's access admits the caller, and as which runner. It runs
 * before oRPC reads the body, as the legacy gate did.
 */
async function admit(access: Access, request: AppRequest): Promise<Admission> {
  switch (access.kind) {
    case 'public':
      return ADMITTED;
    case 'daemon': {
      const refused = await requireApiKey(request);
      return refused ? { refused } : ADMITTED;
    }
    case 'runner': {
      const runner = await authorizeRunnerControl(request, access.scope);
      return runner.authorized ? { refused: null, runner } : { refused: unauthorized() };
    }
    case 'session': {
      const refused = await handleAuth0(request);
      if (refused) return { refused: await asProblem(refused) };
      // The permissions the client gates its navigation and write controls on.
      enrichUserPermissions(request);
      return ADMITTED;
    }
    case 'user': {
      const refused = await authorize(request, access.permission);
      return refused ? { refused: await asProblem(refused) } : ADMITTED;
    }
  }
}

/**
 * `request`, with its body as the route's schema should read it. Every contract
 * body is an object, and a Valibot object schema accepts an array, reading `[]`
 * as `{}`; as null, the schema answers with its own not-an-object message, as
 * readBody did. On a daemon or runner route a body that is not JSON reads as
 * none, so the schema answers with the message each route always gave.
 */
async function bodyAsRead(request: AppRequest, format: DaemonErrors | 'problem'): Promise<Request> {
  if (request.method === 'GET' || request.body === null) return request;
  const body = await readJson(request.clone(), v.unknown());
  if (!body.ok) return format === 'problem' ? request : new Request(request, { body: null });
  if (!Array.isArray(body.value)) return request;
  return new Request(request, { body: 'null' });
}

/** oRPC always answers application/json; restate it as the Worker's other routes do. */
function withMediaType(response: Response, errorType: string): Response {
  const headers = new Headers(response.headers);
  if (headers.has('Content-Type')) {
    headers.set('Content-Type', response.ok ? JSON_TYPE : errorType);
  }
  return new Response(response.body, { status: response.status, headers });
}

const CONTROL_PREFIX = '/api/control/';

/** Logs what a procedure did not expect; an ORPCError is an answer it chose. */
async function logUnexpected({ next }: { next: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof ORPCError)) console.error('[contract] Unexpected error:', error);
    throw error;
  }
}

/** The error format a route answers in: one of the daemon's for /api/control/, else a problem. */
function errorFormat(
  procedure: TraverseContractProcedureCallbackOptions['contract'],
): DaemonErrors | 'problem' {
  if (!(procedure['~orpc'].route.path ?? '').startsWith(CONTROL_PREFIX)) return 'problem';
  const { access } = v.parse(RouteMeta, procedure['~orpc'].meta);
  if (access.kind === 'daemon') return access.errors;
  return access.kind === 'runner' ? 'plain' : 'flagged';
}

/** The routes of `routes` whose callers read one error format. */
function surface(routes: AnyRouter, format: DaemonErrors | 'problem') {
  const filter = ({ contract: procedure }: TraverseContractProcedureCallbackOptions) =>
    errorFormat(procedure) === format;
  const matcher = new StandardOpenAPIMatcher({ filter });
  matcher.init(routes);
  return {
    format,
    matcher,
    handler: new OpenAPIHandler<ContractContext>(routes, {
      filter,
      plugins: [new ResponseHeadersPlugin()],
      clientInterceptors: [logUnexpected],
      customErrorResponseBodyEncoder: format === 'problem' ? problemOf : daemonErrorOf(format),
    }),
    errorType: format === 'problem' ? PROBLEM_TYPE : JSON_TYPE,
  };
}

/** The entry for `routes`: their answer, or null when the request names none of them. */
export function createContractHandler(routes: AnyRouter) {
  const surfaces = [
    surface(routes, 'plain'),
    surface(routes, 'flagged'),
    surface(routes, 'problem'),
  ];
  return async (request: AppRequest): Promise<Response | null> => {
    const pathname: `/${string}` = `/${new URL(request.url).pathname.replace(/^\/|\/$/g, '')}`;
    for (const { format, matcher, handler, errorType } of surfaces) {
      const match = await matcher.match(request.method, pathname);
      if (!match) continue;
      const { access } = v.parse(RouteMeta, match.procedure['~orpc'].meta);
      const admission = await admit(access, request);
      if (admission.refused) return admission.refused;
      const { response } = await handler.handle(await bodyAsRead(request, format), {
        context: { request, resHeaders: new Headers(), runner: admission.runner },
      });
      return response ? withMediaType(response, errorType) : null;
    }
    return null;
  };
}

/** The answer when the request names a contract route, or null for the legacy Router. */
export const handleContract = createContractHandler(router);

/** Every contract route, written as the legacy Router writes paths (`:id`). */
export function contractRoutes(): { method: v.InferOutput<typeof Method>; path: string }[] {
  const routes: { method: v.InferOutput<typeof Method>; path: string }[] = [];
  traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure }) => {
    const { method, path = '' } = procedure['~orpc'].route;
    routes.push({ method: v.parse(Method, method), path: path.replaceAll(/\{([^}]+)\}/g, ':$1') });
  });
  return routes;
}
