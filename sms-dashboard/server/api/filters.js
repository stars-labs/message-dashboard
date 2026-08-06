// Spam/marketing filter rule management.
//
// Every mutation queues the affected messages for re-judgement and then runs one
// bounded sweep, returning how many rows are still pending so the caller can
// keep going. Nothing here decides what spam is — see utils/spam-filter.js.

import { handleAuth0 } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { RULE_TYPE, normalizeSender } from '../utils/spam-filter.js';
import {
  sweepPending,
  markPendingForRule,
  releaseRowsAttributedTo,
  markAllPending,
  countPending,
} from '../utils/spam-backfill.js';

const VALID_RULE_TYPES = Object.values(RULE_TYPE);

/** Shortest allowed body keyword. A single character would hide almost everything. */
const MIN_KEYWORD_LENGTH = 2;

/** Shortest allowed sender pattern, so a stray '1' cannot match half the table. */
const MIN_SENDER_LENGTH = 3;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Auth0 + RBAC gate. Returns a Response to short-circuit, or null to proceed. */
async function gate(request, env, ctx, permission) {
  const authResponse = await handleAuth0(request, env, ctx);
  if (authResponse) return authResponse;
  await enrichUserPermissions(request, env, ctx);
  const permResponse = await requirePermission(permission)(request, env, ctx);
  if (permResponse) return permResponse;
  return null;
}

/**
 * Validate and normalise a rule payload.
 * @returns {{rule_type: string, pattern: string, note: string|null}|{error: string}}
 */
function validateRule({ rule_type, pattern, note }) {
  if (!VALID_RULE_TYPES.includes(rule_type)) {
    return { error: `rule_type must be one of: ${VALID_RULE_TYPES.join(', ')}` };
  }

  const trimmed = typeof pattern === 'string' ? pattern.trim() : '';
  if (!trimmed) return { error: 'pattern is required' };

  if (rule_type === RULE_TYPE.BODY_KEYWORD) {
    if (trimmed.length < MIN_KEYWORD_LENGTH) {
      return { error: `body keyword must be at least ${MIN_KEYWORD_LENGTH} characters` };
    }
    return { rule_type, pattern: trimmed, note: note?.trim() || null };
  }

  // Sender patterns are compared as bare digits, so store them that way —
  // otherwise a rule typed as '+86 10086' could never match anything.
  const digits = normalizeSender(trimmed);
  if (digits !== trimmed) {
    return { error: 'sender pattern must contain digits only (no +, spaces or dashes)' };
  }
  if (digits.length < MIN_SENDER_LENGTH) {
    return { error: `sender pattern must be at least ${MIN_SENDER_LENGTH} digits` };
  }
  return { rule_type, pattern: digits, note: note?.trim() || null };
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(error?.message || '');
}

export function setupFilterRoutes(router) {
  // List rules, with how many messages each is currently hiding.
  router.get('/api/filters', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.read');
    if (blocked) return blocked;

    try {
      const [{ results }, pending] = await Promise.all([
        env.DB.prepare(
          `SELECT r.*,
                  (SELECT COUNT(*) FROM messages m WHERE m.filter_rule_id = r.id) AS hit_count
           FROM filter_rules r
           ORDER BY r.rule_type, r.id`
        ).all(),
        countPending(env.DB),
      ]);

      return json({ filters: results || [], pending });
    } catch (error) {
      console.error('[filters] list failed:', error);
      return json({ error: 'Failed to fetch filter rules' }, 500);
    }
  });

  // Create a rule, then judge the messages it could newly apply to.
  router.post('/api/filters', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.write');
    if (blocked) return blocked;

    try {
      const validated = validateRule(await request.json());
      if (validated.error) return json({ error: validated.error }, 400);

      const inserted = await env.DB.prepare(
        `INSERT INTO filter_rules (rule_type, pattern, note, created_by)
         VALUES (?, ?, ?, ?)
         RETURNING *`
      )
        .bind(
          validated.rule_type,
          validated.pattern,
          validated.note,
          request.user?.sub || null
        )
        .first();

      const queued = await markPendingForRule(env.DB, inserted);
      const sweep = await sweepPending(env.DB);

      return json({ filter: inserted, queued, ...sweep }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return json({ error: 'That rule already exists' }, 409);
      }
      console.error('[filters] create failed:', error);
      return json({ error: 'Failed to create filter rule' }, 500);
    }
  });

  // Update a rule. Anything it currently hides is released and re-judged, because
  // the edit may mean it no longer applies — and those rows may match another rule.
  router.put('/api/filters/:id', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.write');
    if (blocked) return blocked;

    const id = Number(request.params.id);
    try {
      const existing = await env.DB.prepare(`SELECT * FROM filter_rules WHERE id = ?`)
        .bind(id)
        .first();
      if (!existing) return json({ error: 'Filter rule not found' }, 404);

      const body = await request.json();
      const validated = validateRule({
        rule_type: body.rule_type ?? existing.rule_type,
        pattern: body.pattern ?? existing.pattern,
        note: body.note ?? existing.note,
      });
      if (validated.error) return json({ error: validated.error }, 400);

      const isActive = body.is_active === undefined ? existing.is_active : (body.is_active ? 1 : 0);

      const updated = await env.DB.prepare(
        `UPDATE filter_rules
         SET rule_type = ?, pattern = ?, note = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
         RETURNING *`
      )
        .bind(validated.rule_type, validated.pattern, validated.note, isActive, id)
        .first();

      // Release first: what this rule used to hide may no longer qualify.
      const released = await releaseRowsAttributedTo(env.DB, id);
      // Then queue what it now covers, if it is still switched on.
      const queued = isActive ? await markPendingForRule(env.DB, updated) : 0;
      const sweep = await sweepPending(env.DB);

      return json({ filter: updated, released, queued, ...sweep });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return json({ error: 'That rule already exists' }, 409);
      }
      console.error('[filters] update failed:', error);
      return json({ error: 'Failed to update filter rule' }, 500);
    }
  });

  // Delete a rule and re-judge whatever it was hiding.
  router.delete('/api/filters/:id', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.delete');
    if (blocked) return blocked;

    const id = Number(request.params.id);
    try {
      // Release BEFORE the delete. filter_rule_id is ON DELETE SET NULL, so
      // deleting first would erase the attribution and leave those rows hidden
      // with no recoverable reason.
      const released = await releaseRowsAttributedTo(env.DB, id);

      const result = await env.DB.prepare(`DELETE FROM filter_rules WHERE id = ?`)
        .bind(id)
        .run();
      if (!result?.meta?.changes) return json({ error: 'Filter rule not found' }, 404);

      const sweep = await sweepPending(env.DB);
      return json({ success: true, released, ...sweep });
    } catch (error) {
      console.error('[filters] delete failed:', error);
      return json({ error: 'Failed to delete filter rule' }, 500);
    }
  });

  // Re-judge everything. Also the endpoint that backfills messages predating the
  // feature. Safe to call repeatedly: it is idempotent and resumable.
  router.post('/api/filters/reclassify', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.write');
    if (blocked) return blocked;

    try {
      const url = new URL(request.url);
      // Default resumes an interrupted sweep; ?reset=1 re-judges the whole table.
      const queued = url.searchParams.get('reset') === '1'
        ? await markAllPending(env.DB)
        : 0;

      const sweep = await sweepPending(env.DB);
      return json({ success: true, queued, ...sweep });
    } catch (error) {
      console.error('[filters] reclassify failed:', error);
      return json({ error: 'Failed to reclassify messages' }, 500);
    }
  });
}
