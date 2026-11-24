import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import {
  BackfillExecuteSummary,
  type BackfillExecuteBody,
  type BackfillExecuteResponse,
  type BackfillPreviewBody,
  type BackfillPreviewResponse,
  type BackfillVersionConflict,
} from '../../shared/api/carrier-billing.js';
import type { D1 } from '../lib/d1.js';
import { findPriorBackfillExecution, insertBackfillExecutedEvent } from '../db/carrier-billing.js';
import {
  previewCarrierBillBackfill,
  AccountNotReadyError,
} from '../utils/carrier-billing-backfill.js';
import type { BackfillPreview } from '../utils/carrier-billing-backfill.js';
import { processCarrierBillMessage } from '../utils/carrier-billing.js';

/** The stored result of an execution, which a retry with the same key replays. */
const StoredExecution = v.object({ summary: v.optional(BackfillExecuteSummary) });

interface PreviewCall {
  env: { DB: D1<'first' | 'all'> };
}

interface ExecuteCall {
  env: { DB: D1 };
  user?: { id: string } | undefined;
}

/** The preview of `accountId`; an account that is unknown or not active is a conflict. */
async function buildPreview(db: D1<'first' | 'all'>, accountId: string): Promise<BackfillPreview> {
  try {
    return await previewCarrierBillBackfill(db, accountId);
  } catch (error) {
    if (error instanceof AccountNotReadyError) {
      throw new ORPCError('CONFLICT', { message: error.message });
    }
    throw error;
  }
}

export const carrierBillingBackfillHandler = {
  async preview(
    { env }: PreviewCall,
    body: v.InferOutput<typeof BackfillPreviewBody>,
  ): Promise<BackfillPreviewResponse> {
    const preview = await buildPreview(env.DB, body.account_id);
    return {
      success: true,
      account: preview.account,
      summary: preview.summary,
      preview_digest: preview.preview_digest,
      candidates: preview.candidates.map(({ message: _message, ...candidate }) => candidate),
    };
  },

  async execute(
    { env, user }: ExecuteCall,
    rawKey: string | undefined,
    body: v.InferOutput<typeof BackfillExecuteBody>,
  ): Promise<BackfillExecuteResponse> {
    const actor = user?.id;
    const key = rawKey?.trim();
    if (!actor) throw new ORPCError('UNAUTHORIZED');
    if (!key || key.length > 200) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'A bounded Idempotency-Key header is required',
      });
    }
    const accountId = body.account_id;
    const prior = await findPriorBackfillExecution(env.DB, actor, key);
    if (prior) {
      if (prior.billing_account_id !== accountId) {
        throw new ORPCError('CONFLICT', {
          message: 'Idempotency key was already used for another account',
        });
      }
      const stored = parseJson(prior.metadata_json, StoredExecution);
      return {
        success: true,
        idempotent: true,
        summary: stored.ok ? (stored.value.summary ?? null) : null,
      };
    }

    const preview = await buildPreview(env.DB, accountId);
    if (body.expected_version !== preview.account.version) {
      throw new ORPCError('CONFLICT', {
        message: 'Billing account version conflict',
        data: { current_version: preview.account.version } satisfies BackfillVersionConflict,
      });
    }
    if (body.preview_digest !== preview.preview_digest) {
      throw new ORPCError('CONFLICT', { message: 'Backfill preview changed; run preview again' });
    }
    if (preview.candidates.length === 0) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'Backfill preview contains no bill candidates',
      });
    }

    const summary: BackfillExecuteSummary = {
      detected: 0,
      duplicate_detected: 0,
      parse_conflict: 0,
      already_processed: 0,
    };
    for (const candidate of preview.candidates) {
      const processed = await processCarrierBillMessage(env.DB, candidate.message);
      // The preview already guaranteed a parsable bill, so 'ignored' and 'failed'
      // would indicate a concurrent change, not a summary category the operator acts on.
      switch (processed.outcome) {
        case 'detected':
        case 'duplicate_detected':
        case 'parse_conflict':
        case 'already_processed':
          summary[processed.outcome] += 1;
          break;
        case 'ignored':
        case 'failed':
          break;
      }
    }

    await insertBackfillExecutedEvent(env.DB, {
      id: crypto.randomUUID(),
      billingAccountId: accountId,
      actor,
      idempotencyKey: key,
      metadata: JSON.stringify({
        preview_digest: preview.preview_digest,
        summary,
        source_message_groups: preview.candidates.map((candidate) => candidate.source_message_ids),
      }),
    });
    return { success: true, summary };
  },
};
