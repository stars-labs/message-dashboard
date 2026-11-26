import { ORPCError } from '@orpc/server';
import type {
  BalanceBatch,
  BalanceBatchCancelResponse,
  BalanceBatchesResponse,
  BalanceBatchResponse,
} from '../../shared/api/balance-batches.js';
import {
  cancelBalanceBatch,
  findBalanceBatch,
  listRecentBalanceBatches,
  type BatchRow,
} from '../db/balance-batches.js';
import type { D1, D1Batch } from '../lib/d1.js';

const RECENT_BATCHES = 10;

function toBatch(row: BatchRow): BalanceBatch {
  return {
    ...row,
    in_progress: row.total - row.parsed - row.failed - row.cancelled,
  };
}

async function requireBatch(db: D1<'first'>, id: string): Promise<BalanceBatch> {
  const row = await findBalanceBatch(db, id);
  if (row === null) throw new ORPCError('NOT_FOUND', { message: 'Balance batch not found' });
  return toBatch(row);
}

export const balanceBatchesHandler = {
  async list({ env }: { env: { DB: D1<'all'> } }): Promise<BalanceBatchesResponse> {
    const rows = await listRecentBalanceBatches(env.DB, RECENT_BATCHES);
    return { success: true, batches: rows.map(toBatch) };
  },

  async get({ env }: { env: { DB: D1<'first'> } }, id: string): Promise<BalanceBatchResponse> {
    return { success: true, batch: await requireBatch(env.DB, id) };
  },

  async cancel(
    {
      env,
      user,
    }: {
      env: { DB: D1<'first' | 'run'> & D1Batch<'run'> };
      user?: { id: string } | undefined;
    },
    id: string,
  ): Promise<BalanceBatchCancelResponse> {
    if (user === undefined || user.id === '') throw new ORPCError('UNAUTHORIZED');
    await requireBatch(env.DB, id);
    const cancelled = await cancelBalanceBatch(env.DB, id, user.id);
    return { success: true, cancelled, batch: await requireBatch(env.DB, id) };
  },
};
