import { previewCarrierBillBackfill, AccountNotReadyError } from '../utils/carrier-billing-backfill.js';
import type { BackfillPreview } from '../utils/carrier-billing-backfill.js';
import { processCarrierBillMessage } from '../utils/carrier-billing.js';
import type { BillOutcome } from '../utils/carrier-billing.js';
import type { AppRequest } from '../worker-context.js';
import type { D1Database } from '../cf-bindings.js';

/** The outcomes the execute summary counts. Processing can also return 'ignored'. */
type CountedOutcome = Extract<BillOutcome, 'detected' | 'duplicate_detected' | 'parse_conflict' | 'already_processed'>;

/** The request body fields this handler reads. */
interface BackfillBody {
  account_id?: unknown;
  expected_version?: unknown;
  preview_digest?: unknown;
}

type ReadJsonResult =
  | { body: BackfillBody }
  | { response: Response }
  | { error: Response };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson(request: AppRequest): Promise<ReadJsonResult> {
  try {
    return { body: (await request.json()) as BackfillBody };
  } catch {
    return { error: json({ error: 'Body must be JSON' }, 400) };
  }
}

function publicPreview(preview: BackfillPreview) {
  return {
    success: true,
    account: preview.account,
    summary: preview.summary,
    preview_digest: preview.preview_digest,
    candidates: preview.candidates.map(({ message: _message, ...candidate }) => candidate),
  };
}

type BuildPreviewResult = { preview: BackfillPreview } | { response: Response };

async function buildPreview(db: D1Database, accountId: unknown): Promise<BuildPreviewResult> {
  if (typeof accountId !== 'string' || !accountId) {
    return { response: json({ error: 'account_id is required' }, 400) };
  }
  try {
    return { preview: await previewCarrierBillBackfill(db, accountId) };
  } catch (error) {
    if (error instanceof AccountNotReadyError) {
      return { response: json({ error: error.message }, 409) };
    }
    throw error;
  }
}

export const carrierBillingBackfillHandler = {
  async preview(request: AppRequest): Promise<Response> {
    const parsed = await readJson(request);
    if ('error' in parsed) return parsed.error;
    if ('response' in parsed) return parsed.response;
    const result = await buildPreview(request.env.DB, parsed.body.account_id);
    if ('response' in result) return result.response;
    return json(publicPreview(result.preview));
  },

  async execute(request: AppRequest): Promise<Response> {
    const actor = request.user?.id;
    const key = request.headers.get('Idempotency-Key')?.trim();
    if (!actor) return json({ error: 'Unauthorized' }, 401);
    if (!key || key.length > 200) {
      return json({ error: 'A bounded Idempotency-Key header is required' }, 400);
    }
    const parsed = await readJson(request);
    if ('error' in parsed) return parsed.error;
    if ('response' in parsed) return parsed.response;
    const body = parsed.body;
    const accountId = body.account_id;
    const prior = await request.env.DB.prepare(`
      SELECT billing_account_id, metadata_json
      FROM carrier_billing_account_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `).bind(actor, key).first<{ billing_account_id: string; metadata_json: string | null }>();
    if (prior) {
      if (prior.billing_account_id !== accountId) {
        return json({ error: 'Idempotency key was already used for another account' }, 409);
      }
      let metadata: { summary?: unknown } = {};
      try { metadata = JSON.parse(prior.metadata_json || '{}'); } catch { metadata = {}; }
      return json({ success: true, idempotent: true, summary: metadata.summary ?? null });
    }

    const result = await buildPreview(request.env.DB, accountId);
    if ('response' in result) return result.response;
    const preview = result.preview;
    if (!Number.isInteger(body.expected_version)
      || body.expected_version !== preview.account.version) {
      return json({
        error: 'Billing account version conflict',
        current_version: preview.account.version,
      }, 409);
    }
    if (body.preview_digest !== preview.preview_digest) {
      return json({ error: 'Backfill preview changed; run preview again' }, 409);
    }
    if (preview.candidates.length === 0) {
      return json({ error: 'Backfill preview contains no bill candidates' }, 400);
    }

    const summary: Record<CountedOutcome, number> = {
      detected: 0,
      duplicate_detected: 0,
      parse_conflict: 0,
      already_processed: 0,
    };
    for (const candidate of preview.candidates) {
      const processed = await processCarrierBillMessage(request.env.DB, candidate.message);
      // 'ignored' and 'failed' are not counted: the preview already guaranteed a
      // parsable bill, so they would indicate a concurrent change, not a summary
      // category the operator acts on.
      if (Object.hasOwn(summary, processed.outcome)) {
        summary[processed.outcome as CountedOutcome] += 1;
      }
    }

    await request.env.DB.prepare(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject,
        idempotency_key, metadata_json
      ) VALUES (?, ?, 'backfill_executed', ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      accountId,
      actor,
      key,
      JSON.stringify({
        preview_digest: preview.preview_digest,
        summary,
        source_message_groups: preview.candidates.map((candidate) => candidate.source_message_ids),
      }),
    ).run();
    return json({ success: true, summary });
  },
};