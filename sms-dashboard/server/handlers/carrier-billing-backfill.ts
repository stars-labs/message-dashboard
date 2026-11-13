import * as v from 'valibot';
import { parseJson, readJson, type Schema } from '../../shared/parse-json.js';
import { queryFirst, type D1 } from '../lib/d1.js';
import {
  previewCarrierBillBackfill,
  AccountNotReadyError,
} from '../utils/carrier-billing-backfill.js';
import type { BackfillPreview } from '../utils/carrier-billing-backfill.js';
import { processCarrierBillMessage } from '../utils/carrier-billing.js';

const ACCOUNT_MESSAGE = 'account_id is required';
const PREVIEW_MESSAGE = 'expected_version must be an integer and preview_digest a string';

const AccountId = v.pipe(v.string(), v.nonEmpty());

/** Request body of POST /api/carrier-billing/backfill/preview. */
const PreviewBody = v.object({ account_id: AccountId });

/** Request body of POST /api/carrier-billing/backfill/execute: the preview the operator saw. */
const ExecuteBody = v.object({
  account_id: AccountId,
  expected_version: v.pipe(v.number(), v.integer()),
  preview_digest: v.string(),
});

/**
 * The 400 message for a body whose first problem is the named field, missing
 * or invalid; a body that is not an object answers ACCOUNT_MESSAGE. Typed
 * against ExecuteBody, so a new field cannot go without a message.
 */
const FIELD_MESSAGES = {
  account_id: ACCOUNT_MESSAGE,
  expected_version: PREVIEW_MESSAGE,
  preview_digest: PREVIEW_MESSAGE,
} as const satisfies Record<keyof typeof ExecuteBody.entries, string>;

function isBodyField(key: unknown): key is keyof typeof FIELD_MESSAGES {
  return typeof key === 'string' && Object.hasOwn(FIELD_MESSAGES, key);
}

function bodyMessage(issue: v.BaseIssue<unknown>): string {
  const key = issue.path?.[0]?.key;
  return isBodyField(key) ? FIELD_MESSAGES[key] : ACCOUNT_MESSAGE;
}

/** The outcomes an execution counts; processing can also report 'ignored' and 'failed'. */
const ExecuteSummary = v.object({
  detected: v.number(),
  duplicate_detected: v.number(),
  parse_conflict: v.number(),
  already_processed: v.number(),
});

type ExecuteSummary = v.InferOutput<typeof ExecuteSummary>;

/** The stored result of an execution, which a retry with the same key replays. */
const StoredExecution = v.object({ summary: v.optional(ExecuteSummary) });

const PriorExecutionRow = v.object({
  billing_account_id: v.string(),
  metadata_json: v.string(),
});

interface PreviewRequest {
  env: { DB: D1<'first' | 'all'> };
  text(): Promise<string>;
}

interface ExecuteRequest {
  env: { DB: D1 };
  user?: { id: string };
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

type BodyResult<T> = { body: T } | { response: Response };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readBody<T>(
  request: { text(): Promise<string> },
  schema: Schema<T>,
): Promise<BodyResult<T>> {
  const raw = await readJson(request, v.unknown());
  if (!raw.ok) return { response: json({ error: 'Body must be JSON' }, 400) };
  const parsed = v.safeParse(schema, raw.value);
  if (parsed.success) return { body: parsed.output };
  return { response: json({ error: bodyMessage(parsed.issues[0]) }, 400) };
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

async function buildPreview(
  db: D1<'first' | 'all'>,
  accountId: string,
): Promise<BuildPreviewResult> {
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
  async preview(request: PreviewRequest): Promise<Response> {
    const parsed = await readBody(request, PreviewBody);
    if ('response' in parsed) return parsed.response;
    const result = await buildPreview(request.env.DB, parsed.body.account_id);
    if ('response' in result) return result.response;
    return json(publicPreview(result.preview));
  },

  async execute(request: ExecuteRequest): Promise<Response> {
    const actor = request.user?.id;
    const key = request.headers.get('Idempotency-Key')?.trim();
    if (!actor) return json({ error: 'Unauthorized' }, 401);
    if (!key || key.length > 200) {
      return json({ error: 'A bounded Idempotency-Key header is required' }, 400);
    }
    const parsed = await readBody(request, ExecuteBody);
    if ('response' in parsed) return parsed.response;
    const body = parsed.body;
    const accountId = body.account_id;
    const prior = await queryFirst(
      request.env.DB.prepare(
        `
      SELECT billing_account_id, metadata_json
      FROM carrier_billing_account_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `,
      ).bind(actor, key),
      PriorExecutionRow,
    );
    if (prior) {
      if (prior.billing_account_id !== accountId) {
        return json({ error: 'Idempotency key was already used for another account' }, 409);
      }
      const stored = parseJson(prior.metadata_json, StoredExecution);
      return json({
        success: true,
        idempotent: true,
        summary: stored.ok ? (stored.value.summary ?? null) : null,
      });
    }

    const result = await buildPreview(request.env.DB, accountId);
    if ('response' in result) return result.response;
    const preview = result.preview;
    if (body.expected_version !== preview.account.version) {
      return json(
        {
          error: 'Billing account version conflict',
          current_version: preview.account.version,
        },
        409,
      );
    }
    if (body.preview_digest !== preview.preview_digest) {
      return json({ error: 'Backfill preview changed; run preview again' }, 409);
    }
    if (preview.candidates.length === 0) {
      return json({ error: 'Backfill preview contains no bill candidates' }, 400);
    }

    const summary: ExecuteSummary = {
      detected: 0,
      duplicate_detected: 0,
      parse_conflict: 0,
      already_processed: 0,
    };
    for (const candidate of preview.candidates) {
      const processed = await processCarrierBillMessage(request.env.DB, candidate.message);
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

    await request.env.DB.prepare(
      `
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject,
        idempotency_key, metadata_json
      ) VALUES (?, ?, 'backfill_executed', ?, ?, ?)
    `,
    )
      .bind(
        crypto.randomUUID(),
        accountId,
        actor,
        key,
        JSON.stringify({
          preview_digest: preview.preview_digest,
          summary,
          source_message_groups: preview.candidates.map(
            (candidate) => candidate.source_message_ids,
          ),
        }),
      )
      .run();
    return json({ success: true, summary });
  },
};
