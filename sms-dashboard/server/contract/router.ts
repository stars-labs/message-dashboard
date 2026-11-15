import { implement } from '@orpc/server';
import { contract } from '../../shared/api/contract/index.js';
import { recordHeartbeat } from '../handlers/control.js';
import { usersHandler } from '../handlers/users.js';
import type { AppRequest } from '../worker-context.js';

export interface ContractContext {
  /** Authorized for the route's declared access before the procedure runs. */
  request: AppRequest;
  resHeaders: Headers;
}

const os = implement(contract).$context<ContractContext>();

export const router = os.router({
  control: {
    heartbeat: os.control.heartbeat.handler(({ context, input }) =>
      recordHeartbeat(context.request, input),
    ),
  },
  users: {
    list: os.users.list.handler(({ context: { request, resHeaders } }) =>
      usersHandler.list({ env: request.env, resHeaders }),
    ),
    setRole: os.users.setRole.handler(({ context: { request, resHeaders }, input }) =>
      usersHandler.setRole(
        { env: request.env, user: request.user, resHeaders },
        input.params.id,
        input.body.role,
      ),
    ),
  },
});
