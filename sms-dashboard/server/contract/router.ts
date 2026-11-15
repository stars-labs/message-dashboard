import { implement } from '@orpc/server';
import { contract } from '../../shared/api/contract/index.js';
import { filtersHandler } from '../api/filters.js';
import { keywordsHandler } from '../api/keywords.js';
import { verificationHandler } from '../api/verification.js';
import { auth0Handler } from '../handlers/auth0.js';
import { recordHeartbeat } from '../handlers/control.js';
import { healthHandler } from '../handlers/health.js';
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
  health: {
    live: os.health.live.handler(({ context }) => healthHandler.live(context)),
    ready: os.health.ready.handler(({ context: { request, resHeaders } }) =>
      healthHandler.check({ env: request.env, resHeaders }),
    ),
    daemonStatus: os.health.daemonStatus.handler(({ context: { request, resHeaders } }) =>
      healthHandler.daemonStatus({ env: request.env, resHeaders }),
    ),
  },
  auth: {
    me: os.auth.me.handler(({ context }) => auth0Handler.me(context.request)),
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
  keywords: {
    list: os.keywords.list.handler(({ context }) => keywordsHandler.list(context.request)),
    get: os.keywords.get.handler(({ context, input }) =>
      keywordsHandler.get(context.request, input.params.id),
    ),
    create: os.keywords.create.handler(({ context, input }) =>
      keywordsHandler.create(context.request, input),
    ),
    update: os.keywords.update.handler(({ context, input }) =>
      keywordsHandler.update(context.request, input.params.id, input.body),
    ),
    remove: os.keywords.remove.handler(({ context, input }) =>
      keywordsHandler.remove(context.request, input.params.id),
    ),
    history: os.keywords.history.handler(({ context, input }) =>
      keywordsHandler.history(context.request, input.params.id, input.body),
    ),
    batchTags: os.keywords.batchTags.handler(({ context, input }) =>
      keywordsHandler.batchTags(context.request, input),
    ),
    messageTags: os.keywords.messageTags.handler(({ context, input }) =>
      keywordsHandler.messageTags(context.request, input.params.id),
    ),
  },
  filters: {
    list: os.filters.list.handler(({ context }) => filtersHandler.list(context.request)),
    create: os.filters.create.handler(({ context, input }) =>
      filtersHandler.create(context.request, input),
    ),
    update: os.filters.update.handler(({ context, input }) =>
      filtersHandler.update(context.request, input.params.id, input.body),
    ),
    remove: os.filters.remove.handler(({ context, input }) =>
      filtersHandler.remove(context.request, input.params.id),
    ),
    history: os.filters.history.handler(({ context, input }) =>
      filtersHandler.history(context.request, input.params.id, input.body),
    ),
  },
  verification: {
    reprocess: os.verification.reprocess.handler(({ context, input }) =>
      verificationHandler.reprocess(context.request, input.query),
    ),
  },
});
