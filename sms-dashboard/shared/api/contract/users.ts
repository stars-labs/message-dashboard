import * as v from 'valibot';
import { SetRoleResponse, UsersResponse } from '../users.js';
import { route } from './route.js';

/** User + role administration, admin-only. */
export const users = {
  list: route({ kind: 'user', permission: 'users.read' }, 'GET', '/api/users').output(
    UsersResponse,
  ),
  setRole: route({ kind: 'user', permission: 'users.write' }, 'PUT', '/api/users/{id}/role')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: v.object({ id: v.string() }), body: v.object({ role: v.string() }) }))
    .output(SetRoleResponse),
};
