import { oc } from '@orpc/contract';
import * as v from 'valibot';
import { ALL_PERMISSIONS } from '../../../config/auth0-roles.js';
import { ALL_RUNNER_SCOPES } from '../runner-scopes.js';

/**
 * Who may call a route: anyone (`public`), anyone signed in whatever their role
 * (`session`), a signed-in user holding a permission (`user`), the API key the
 * Pi daemon and the ops scripts hold (`daemon`), or a Balance Agent holding the
 * API key or an Auth0 token with the route's scope (`runner`). A daemon route
 * also says how it refuses a request: `{ error }` (`plain`) or
 * `{ success: false, error }` (`flagged`), as each did before the contract; a
 * runner route refuses in `{ error }`. shared/control-fixtures/ and the route
 * tests pin them.
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

/**
 * A route of the contract. The only way to declare one, so no route exists
 * without saying who may call it.
 */
export function route(access: Access, method: Method, path: `/api/${string}`) {
  return oc.$meta<v.InferOutput<typeof RouteMeta>>({ access }).route({ method, path });
}
