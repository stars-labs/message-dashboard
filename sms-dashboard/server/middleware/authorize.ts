import type { Permission } from '../../config/auth0-roles.js';
import type { SessionUser } from '../../shared/api/auth.js';
import { handleAuth0, type AuthRequest } from './auth0.js';
import { enrichUserPermissions, requirePermission } from './rbac.js';

export interface AuthorizeRequest extends AuthRequest {
  user?: SessionUser & { permissions?: string[] };
}

/**
 * The Auth0 + RBAC gate for a dashboard route: a 401/403 Response to answer
 * instead, or undefined once the caller holds `permission`.
 */
export async function authorize(
  request: AuthorizeRequest,
  permission: Permission,
): Promise<Response | undefined> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  return requirePermission(permission)(request);
}
