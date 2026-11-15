import { oc } from '@orpc/contract';
import * as v from 'valibot';
import { ALL_PERMISSIONS } from '../../../config/auth0-roles.js';

/**
 * Who may call a route: anyone (`public`), anyone signed in whatever their role
 * (`session`), a signed-in user holding a permission (`user`), or the Pi daemon's
 * API key (`daemon`).
 */
export const Access = v.variant('kind', [
  v.strictObject({ kind: v.literal('public') }),
  v.strictObject({ kind: v.literal('session') }),
  v.strictObject({ kind: v.literal('user'), permission: v.picklist(ALL_PERMISSIONS) }),
  v.strictObject({ kind: v.literal('daemon') }),
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
