// Spam/marketing filter rule management.
//
// Rule mutations affect new ingestion only. Historical changes are a separate,
// explicitly requested, one-page-at-a-time operation. Nothing here decides what
// spam is — see utils/spam-filter.js.

import { handleAuth0 } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { RULE_TYPE, normalizeSender } from '../utils/spam-filter.js';
import { processRuleHistoryPage } from '../utils/filter-history.js';

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

  if (trimmed.length < MIN_SENDER_LENGTH) {
    return { error: `sender pattern must be at least ${MIN_SENDER_LENGTH} characters` };
  }

  // Numeric short codes retain the existing canonical storage format. Named
  // sender IDs are stored verbatim and compared case-insensitively.
  if (/^[+\d\s-]+$/.test(trimmed)) {
    const digits = normalizeSender(trimmed);
    if (digits.length < MIN_SENDER_LENGTH) {
      return { error: `sender pattern must contain at least ${MIN_SENDER_LENGTH} digits` };
    }
    return { rule_type, pattern: digits, note: note?.trim() || null };
  }

  return { rule_type, pattern: trimmed, note: note?.trim() || null };
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(error?.message || '');
}

export async function listFilterRules(db) {
  const { results } = await db.prepare(
    `SELECT *
     FROM filter_rules
     ORDER BY rule_type, id`
  ).all();

  return { filters: results || [] };
}

export function setupFilterRoutes(router) {
  // List rule metadata only. Historical hit counts require reading every matched
  // message and are not part of the dashboard's operational rule contract.
  router.get('/api/filters', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.read');
    if (blocked) return blocked;

    try {
      return json(await listFilterRules(env.DB));
    } catch (error) {
      console.error('[filters] list failed:', error);
      return json({ error: 'Failed to fetch filter rules' }, 500);
    }
  });

  // Create a prospective rule. Existing messages remain historical facts.
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

      return json({ filter: inserted }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return json({ error: 'That rule already exists' }, 409);
      }
      console.error('[filters] create failed:', error);
      return json({ error: 'Failed to create filter rule' }, 500);
    }
  });

  // Matching identity is immutable. Notes and prospective active state may change.
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
      if (
        (body.rule_type !== undefined && body.rule_type !== existing.rule_type)
        || (
          body.pattern !== undefined
          && (typeof body.pattern !== 'string' || body.pattern.trim() !== existing.pattern)
        )
      ) {
        return json({ error: 'Rule type and pattern are immutable; create a new rule instead' }, 400);
      }
      const validated = validateRule({
        rule_type: existing.rule_type,
        pattern: existing.pattern,
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

      return json({ filter: updated });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return json({ error: 'That rule already exists' }, 409);
      }
      console.error('[filters] update failed:', error);
      return json({ error: 'Failed to update filter rule' }, 500);
    }
  });

  // A referenced rule is historical provenance and cannot be physically deleted.
  router.delete('/api/filters/:id', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.delete');
    if (blocked) return blocked;

    const id = Number(request.params.id);
    try {
      const referenced = await env.DB.prepare(
        `SELECT 1 FROM messages WHERE filter_rule_id = ? LIMIT 1`
      ).bind(id).first();
      if (referenced) {
        return json({ error: 'Rule has historical messages; deactivate it instead' }, 409);
      }

      const result = await env.DB.prepare(`DELETE FROM filter_rules WHERE id = ?`)
        .bind(id)
        .run();
      if (!result?.meta?.changes) return json({ error: 'Filter rule not found' }, 404);

      return json({ success: true });
    } catch (error) {
      console.error('[filters] delete failed:', error);
      return json({ error: 'Failed to delete filter rule' }, 500);
    }
  });

  // Historical changes are explicit, bounded, and one page per operator action.
  router.post('/api/filters/:id/history', async (request, env, ctx) => {
    const blocked = await gate(request, env, ctx, 'filters.write');
    if (blocked) return blocked;

    const id = Number(request.params.id);
    try {
      const rule = await env.DB.prepare(`SELECT * FROM filter_rules WHERE id = ?`)
        .bind(id)
        .first();
      if (!rule) return json({ error: 'Filter rule not found' }, 404);

      const body = await request.json();
      const since = new Date(body.since);
      const until = new Date(body.until);
      if (
        Number.isNaN(since.getTime())
        || Number.isNaN(until.getTime())
        || since > until
      ) {
        return json({ error: 'A valid history time range is required' }, 400);
      }
      const cursor = body.cursor || null;
      if (
        cursor
        && (
          typeof cursor.created_at !== 'string'
          || typeof cursor.id !== 'string'
          || Number.isNaN(new Date(`${cursor.created_at}Z`).getTime())
        )
      ) {
        return json({ error: 'Invalid history cursor' }, 400);
      }

      const result = await processRuleHistoryPage(env.DB, rule, {
        since: since.toISOString(),
        until: until.toISOString(),
        cursor,
      });
      return json(result);
    } catch (error) {
      console.error('[filters] history processing failed:', error);
      return json({ error: 'Failed to process filter history' }, 500);
    }
  });
}
