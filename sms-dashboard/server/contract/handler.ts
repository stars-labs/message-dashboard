import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { StandardOpenAPIMatcher } from '@orpc/openapi/standard';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { traverseContractProcedures, type AnyRouter } from '@orpc/server';
import * as v from 'valibot';
import { contract } from '../../shared/api/contract/index.js';
import { Method, RouteMeta, type Access } from '../../shared/api/contract/route.js';
import { ErrorResponse } from '../../shared/api/error.js';
import { readJson } from '../../shared/parse-json.js';
import { requireApiKey } from '../handlers/control.js';
import { authorize } from '../middleware/authorize.js';
import type { AppRequest } from '../worker-context.js';
import { daemonErrorOf, problem, problemOf } from './errors.js';
import { router, type ContractContext } from './router.js';

const JSON_TYPE = 'application/json;charset=utf-8';
const PROBLEM_TYPE = 'application/problem+json';

const RefusalBody = v.object({ ...ErrorResponse.entries, message: v.optional(v.string()) });

/** A 401/403 from the Auth0 + RBAC gate, as a problem. */
async function asProblem(refused: Response): Promise<Response> {
  const body = await readJson(refused, RefusalBody);
  const detail = body.ok ? (body.value.message ?? body.value.error) : refused.statusText;
  const code = refused.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED';
  return new Response(JSON.stringify(problem(refused.status, code, detail)), {
    status: refused.status,
    headers: { 'Content-Type': PROBLEM_TYPE },
  });
}

/**
 * The refusal for a caller the route's access does not admit, or null. It runs
 * before oRPC reads the body, as the legacy gate did.
 */
async function refusal(access: Access, request: AppRequest): Promise<Response | null> {
  if (access.kind === 'daemon') return requireApiKey(request);
  const refused = await authorize(request, access.permission);
  return refused ? asProblem(refused) : null;
}

/** oRPC always answers application/json; restate it as the Worker's other routes do. */
function withMediaType(response: Response, errorType: string): Response {
  const headers = new Headers(response.headers);
  if (headers.has('Content-Type')) {
    headers.set('Content-Type', response.ok ? JSON_TYPE : errorType);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** One part of the contract, with the error format its callers read. */
function surface(routes: AnyRouter, encodeError: typeof problemOf | typeof daemonErrorOf) {
  const matcher = new StandardOpenAPIMatcher();
  matcher.init(routes);
  return {
    matcher,
    handler: new OpenAPIHandler<ContractContext>(routes, {
      plugins: [new ResponseHeadersPlugin()],
      customErrorResponseBodyEncoder: encodeError,
    }),
    errorType: encodeError === problemOf ? PROBLEM_TYPE : JSON_TYPE,
  };
}

const SURFACES = [
  surface({ control: router.control }, daemonErrorOf),
  surface({ users: router.users }, problemOf),
];

/** The answer when the request names a contract route, or null for the legacy Router. */
export async function handleContract(request: AppRequest): Promise<Response | null> {
  const pathname: `/${string}` = `/${new URL(request.url).pathname.replace(/^\/|\/$/g, '')}`;
  for (const { matcher, handler, errorType } of SURFACES) {
    const match = await matcher.match(request.method, pathname);
    if (!match) continue;
    const { access } = v.parse(RouteMeta, match.procedure['~orpc'].meta);
    const refused = await refusal(access, request);
    if (refused) return refused;
    const { response } = await handler.handle(request, {
      context: { request, resHeaders: new Headers() },
    });
    return response ? withMediaType(response, errorType) : null;
  }
  return null;
}

/** Every contract route, written as the legacy Router writes paths (`:id`). */
export function contractRoutes(): { method: v.InferOutput<typeof Method>; path: string }[] {
  const routes: { method: v.InferOutput<typeof Method>; path: string }[] = [];
  traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure }) => {
    const { method, path = '' } = procedure['~orpc'].route;
    routes.push({ method: v.parse(Method, method), path: path.replaceAll(/\{([^}]+)\}/g, ':$1') });
  });
  return routes;
}
