import { previewCarrierBillBackfill } from '../utils/carrier-billing-backfill.js';
import { processCarrierBillMessage } from '../utils/carrier-billing.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: json({ error: 'Body must be JSON' }, 400) };
  }
}

function publicPreview(preview) {
  return {
    success: true,
    account: preview.account,
    summary: preview.summary,
    preview_digest: preview.preview_digest,
    candidates: preview.candidates.map(({ message: _message, ...candidate }) => candidate),
  };
}

async function buildPreview(db, accountId) {
  if (typeof accountId !== 'string' || !accountId) {
    return { response: json({ error: 'account_id is required' }, 400) };
  }
  try {
    return { preview: await previewCarrierBillBackfill(db, accountId) };
  } catch (error) {
    if (error?.code === 'ACCOUNT_NOT_READY') {
      return { response: json({ error: error.message }, 409) };
    }
    throw error;
  }
}

export const carrierBillingBackfillHandler = {
  async preview(request) {
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const result = await buildPreview(request.env.DB, parsed.body?.account_id);
    if (result.response) return result.response;
    return json(publicPreview(result.preview));
  },

  async execute(request) {
    const actor = request.user?.id;
    const key = request.headers.get('Idempotency-Key')?.trim();
    if (!actor) return json({ error: 'Unauthorized' }, 401);
    if (!key || key.length > 200) {
      return json({ error: 'A bounded Idempotency-Key header is required' }, 400);
    }
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const accountId = parsed.body?.account_id;
    const prior = await request.env.DB.prepare(`
      SELECT billing_account_id, metadata_json
      FROM carrier_billing_account_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `).bind(actor, key).first();
    if (prior) {
      if (prior.billing_account_id !== accountId) {
        return json({ error: 'Idempotency key was already used for another account' }, 409);
      }
      let metadata = {};
      try { metadata = JSON.parse(prior.metadata_json || '{}'); } catch { metadata = {}; }
      return json({ success: true, idempotent: true, summary: metadata.summary ?? null });
    }

    const result = await buildPreview(request.env.DB, accountId);
    if (result.response) return result.response;
    const preview = result.preview;
    if (!Number.isInteger(parsed.body?.expected_version)
      || parsed.body.expected_version !== preview.account.version) {
      return json({
        error: 'Billing account version conflict',
        current_version: preview.account.version,
      }, 409);
    }
    if (parsed.body?.preview_digest !== preview.preview_digest) {
      return json({ error: 'Backfill preview changed; run preview again' }, 409);
    }
    if (preview.candidates.length === 0) {
      return json({ error: 'Backfill preview contains no bill candidates' }, 400);
    }

    const summary = {
      detected: 0,
      duplicate_detected: 0,
      parse_conflict: 0,
      already_processed: 0,
    };
    for (const candidate of preview.candidates) {
      const processed = await processCarrierBillMessage(request.env.DB, candidate.message);
      if (Object.hasOwn(summary, processed.outcome)) summary[processed.outcome] += 1;
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
