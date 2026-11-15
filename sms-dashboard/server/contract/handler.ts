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
import { requireApiKey } from '../handlers/control.js';
import { handleAuth0 } from '../middleware/auth0.js';
import { authorize } from '../middleware/authorize.js';
import { enrichUserPermissions } from '../middleware/rbac.js';
import type { AppRequest } from '../worker-context.js';
import { daemonErrorOf, problemOf, problemResponse } from './errors.js';
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

/**
 * The refusal for a caller the route's access does not admit, or null. It runs
 * before oRPC reads the body, as the legacy gate did.
 */
async function refusal(access: Access, request: AppRequest): Promise<Response | null> {
  switch (access.kind) {
    case 'public':
      return null;
    case 'daemon':
      return requireApiKey(request);
    case 'session': {
      const refused = await handleAuth0(request);
      if (refused) return asProblem(refused);
      // The permissions the client gates its navigation and write controls on.
      enrichUserPermissions(request);
      return null;
    }
    case 'user': {
      const refused = await authorize(request, access.permission);
      return refused ? asProblem(refused) : null;
    }
  }
}

/**
 * `request`, with a JSON array body read as null. Every contract body is an
 * object, and a Valibot object schema accepts an array, reading `[]` as `{}`;
 * as null, the schema answers with its own not-an-object message, as readBody did.
 */
async function withoutArrayBody(request: AppRequest): Promise<Request> {
  if (request.method === 'GET' || request.body === null) return request;
  const body = await readJson(request.clone(), v.unknown());
  if (!body.ok || !Array.isArray(body.value)) return request;
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

/**
 * The routes of `routes` whose callers read one error format: the daemon's for
 * /api/control/, which shared/control-fixtures/ pins, and a problem for the rest.
 */
function surface(routes: AnyRouter, control: boolean) {
  const filter = ({ contract: procedure }: TraverseContractProcedureCallbackOptions) =>
    (procedure['~orpc'].route.path ?? '').startsWith(CONTROL_PREFIX) === control;
  const matcher = new StandardOpenAPIMatcher({ filter });
  matcher.init(routes);
  return {
    matcher,
    handler: new OpenAPIHandler<ContractContext>(routes, {
      filter,
      plugins: [new ResponseHeadersPlugin()],
      clientInterceptors: [logUnexpected],
      customErrorResponseBodyEncoder: control ? daemonErrorOf : problemOf,
    }),
    errorType: control ? JSON_TYPE : PROBLEM_TYPE,
  };
}

/** The entry for `routes`: their answer, or null when the request names none of them. */
export function createContractHandler(routes: AnyRouter) {
  const surfaces = [surface(routes, true), surface(routes, false)];
  return async (request: AppRequest): Promise<Response | null> => {
    const pathname: `/${string}` = `/${new URL(request.url).pathname.replace(/^\/|\/$/g, '')}`;
    for (const { matcher, handler, errorType } of surfaces) {
      const match = await matcher.match(request.method, pathname);
      if (!match) continue;
      const { access } = v.parse(RouteMeta, match.procedure['~orpc'].meta);
      const refused = await refusal(access, request);
      if (refused) return refused;
      const { response } = await handler.handle(await withoutArrayBody(request), {
        context: { request, resHeaders: new Headers() },
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
