import type { Permission } from '../../config/auth0-roles.js';
import type { SessionUser } from '../../shared/api/auth.js';
import { handleAuth0, type AuthRequest } from './auth0.js';
import { enrichUserPermissions, requirePermission } from './rbac.js';

export interface AuthorizeRequest extends AuthRequest {
  user?: SessionUser & { permissions?: string[] };
}

export async function authorize(
  request: AuthorizeRequest,
  permission: Permission,
): Promise<Response | undefined> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  return requirePermission(permission)(request);
}
