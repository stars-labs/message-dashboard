import { ORPCError } from '@orpc/server';
import type * as v from 'valibot';
import type { ReprocessQuery, ReprocessResponse } from '../../shared/api/verification.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { reprocessVerificationPage } from '../utils/verification-backfill.js';
import { sweepPending } from '../utils/spam-backfill.js';

interface VerificationCall {
  env: { DB: D1<'all' | 'first' | 'run'> & D1Batch<'all' | 'first' | 'run'> };
}

export const verificationHandler = {
  async reprocess(
    { env }: VerificationCall,
    query: v.InferOutput<typeof ReprocessQuery>,
  ): Promise<ReprocessResponse> {
    try {
      const page = await reprocessVerificationPage(env.DB, {
        after: query.after ?? 0,
        pageSize: query.limit,
        dryRun: query.dry_run === '1',
      });

      const filterSweep = page.dry_run || page.changed === 0 ? null : await sweepPending(env.DB);

      return { success: true, ...page, filter_sweep: filterSweep };
    } catch (error) {
      console.error('[verification] reprocess failed:', error);
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'Failed to reprocess verification codes',
      });
    }
  },
};
