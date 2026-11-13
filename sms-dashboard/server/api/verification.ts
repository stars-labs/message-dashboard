import { handleAuth0 } from '../middleware/auth0.js';
import { enrichUserPermissions, requirePermission } from '../middleware/rbac.js';
import { reprocessVerificationPage } from '../utils/verification-backfill.js';
import { sweepPending } from '../utils/spam-backfill.js';
import type { Handler, AppRequest, Env } from '../worker-context.js';
import type { ExecutionContext } from '../cf-bindings.js';

/** The router shape this module needs. */
interface Router {
  post(path: string, ...handlers: Handler[]): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function gate(
  request: AppRequest,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request);
  return (await requirePermission('filters.write')(request)) || null;
}

export function setupVerificationRoutes(router: Router): void {
  router.post(
    '/api/verification/reprocess',
    async (request: AppRequest, env: Env, ctx: ExecutionContext) => {
      const blocked = await gate(request, env, ctx);
      if (blocked) return blocked;

      try {
        const url = new URL(request.url);
        const page = await reprocessVerificationPage(env.DB, {
          after: url.searchParams.get('after') || 0,
          pageSize: url.searchParams.get('limit') || undefined,
          dryRun: url.searchParams.get('dry_run') === '1',
        });

        const filterSweep = page.dry_run || page.changed === 0 ? null : await sweepPending(env.DB);

        return json({ success: true, ...page, filter_sweep: filterSweep });
      } catch (error) {
        console.error('[verification] reprocess failed:', error);
        return json({ error: 'Failed to reprocess verification codes' }, 500);
      }
    },
  );
}
