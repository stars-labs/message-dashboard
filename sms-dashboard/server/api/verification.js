import { handleAuth0 } from '../middleware/auth0.js';
import { enrichUserPermissions, requirePermission } from '../middleware/rbac.js';
import { reprocessVerificationPage } from '../utils/verification-backfill.js';
import { sweepPending } from '../utils/spam-backfill.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function gate(request, env, ctx) {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  return (await requirePermission('filters.write')(request, env, ctx)) || null;
}

export function setupVerificationRoutes(router) {
  router.post('/api/verification/reprocess', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx);
    if (blocked) return blocked;

    try {
      const url = new URL(request.url);
      const page = await reprocessVerificationPage(env.DB, {
        after: url.searchParams.get('after') || 0,
        pageSize: url.searchParams.get('limit') || undefined,
        dryRun: url.searchParams.get('dry_run') === '1',
      });

      const filterSweep = page.dry_run || page.changed === 0
        ? null
        : await sweepPending(env.DB);

      return json({ success: true, ...page, filter_sweep: filterSweep });
    } catch (error) {
      console.error('[verification] reprocess failed:', error);
      return json({ error: 'Failed to reprocess verification codes' }, 500);
    }
  });
}
