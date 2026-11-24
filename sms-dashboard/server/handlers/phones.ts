import { ORPCError } from '@orpc/server';
import type { PhonesResponse } from '../../shared/api/phones.js';
import { listPhones } from '../db/phones.js';
import type { D1 } from '../lib/d1.js';

interface ListCall {
  env: { DB: D1<'all'> };
}

export const phonesHandler = {
  async list({ env }: ListCall): Promise<PhonesResponse> {
    try {
      return { success: true, data: await listPhones(env.DB) };
    } catch (error) {
      console.error(
        '[Phones] List error:',
        error instanceof Error ? (error.stack ?? error) : error,
      );
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Failed to fetch phones' });
    }
  },
};
