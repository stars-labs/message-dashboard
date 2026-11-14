import { json } from '../lib/response.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { handleAuth0, type AuthRequest } from '../middleware/auth0.js';
import { enrichUserPermissions, requirePermission } from '../middleware/rbac.js';
import { reprocessVerificationPage } from '../utils/verification-backfill.js';
import { sweepPending } from '../utils/spam-backfill.js';

type VerificationDb = D1<'all' | 'first' | 'run'> & D1Batch<'all' | 'first' | 'run'>;

interface VerificationRequest extends AuthRequest {
  env: AuthRequest['env'] & { DB: VerificationDb };
}

/** The router shape this module needs. */
interface Router {
  post(path: string, handler: (request: VerificationRequest) => Promise<Response>): void;
}

async function gate(request: VerificationRequest): Promise<Response | null> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  return requirePermission('filters.write')(request) ?? null;
}

export function setupVerificationRoutes(router: Router): void {
  router.post('/api/verification/reprocess', async (request) => {
    const blocked = await gate(request);
    if (blocked) return blocked;

    try {
      const url = new URL(request.url);
      const page = await reprocessVerificationPage(request.env.DB, {
        after: url.searchParams.get('after') ?? 0,
        pageSize: url.searchParams.get('limit') ?? undefined,
        dryRun: url.searchParams.get('dry_run') === '1',
      });

      const filterSweep =
        page.dry_run || page.changed === 0 ? null : await sweepPending(request.env.DB);

      return json({ success: true, ...page, filter_sweep: filterSweep });
    } catch (error) {
      console.error('[verification] reprocess failed:', error);
      return json({ error: 'Failed to reprocess verification codes' }, 500);
    }
  });
}
