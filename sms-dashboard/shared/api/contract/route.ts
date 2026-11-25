import { oc } from '@orpc/contract';
import * as v from 'valibot';
import { ALL_PERMISSIONS } from '../../../config/auth0-roles.js';
import { ALL_RUNNER_SCOPES } from '../runner-scopes.js';

/**
 * `session`: signed in, any role. `daemon`: the API key the Pi daemon holds.
 * `runner`: the API key or an Auth0 token with the route's scope. A daemon route says how
 * it refuses: `{ error }` (`plain`) or `{ success: false, error }` (`flagged`); a runner
 * route refuses in `{ error }`. shared/control-fixtures/ pins them.
 */
export const Access = v.variant('kind', [
  v.strictObject({ kind: v.literal('public') }),
  v.strictObject({ kind: v.literal('session') }),
  v.strictObject({ kind: v.literal('user'), permission: v.picklist(ALL_PERMISSIONS) }),
  v.strictObject({ kind: v.literal('daemon'), errors: v.picklist(['plain', 'flagged']) }),
  v.strictObject({ kind: v.literal('runner'), scope: v.picklist(ALL_RUNNER_SCOPES) }),
]);

export type Access = v.InferOutput<typeof Access>;

export const RouteMeta = v.strictObject({ access: Access });

export const Method = v.picklist(['GET', 'POST', 'PUT', 'DELETE']);

type Method = v.InferOutput<typeof Method>;

/** The only way to declare a route, so none exists without saying who may call it. */
export function route(access: Access, method: Method, path: `/api/${string}`) {
  return oc.$meta<v.InferOutput<typeof RouteMeta>>({ access }).route({ method, path });
}
