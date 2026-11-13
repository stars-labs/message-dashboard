// Spam/marketing filter rule management.
//
// Rule mutations affect new ingestion only. Historical changes are a separate,
// explicitly requested, one-page-at-a-time operation. Nothing here decides what
// spam is — see utils/spam-filter.ts.

import * as v from 'valibot';
import { readJson, type Schema } from '../../shared/parse-json.js';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';
import { handleAuth0, type AuthRequest } from '../middleware/auth0.js';
import { requirePermission, enrichUserPermissions } from '../middleware/rbac.js';
import { RULE_TYPE, normalizeSender } from '../utils/spam-filter.js';
import { processRuleHistoryPage } from '../utils/filter-history.js';
import type { HistoryCursor } from '../utils/filter-history.js';
import { errorText } from '../utils/d1-error.js';
import type { Permission } from '../../config/auth0-roles.js';

const VALID_RULE_TYPES: string[] = Object.values(RULE_TYPE);

/** Shortest allowed body keyword. A single character would hide almost everything. */
const MIN_KEYWORD_LENGTH = 2;

/** Shortest allowed sender pattern, so a stray '1' cannot match half the table. */
const MIN_SENDER_LENGTH = 3;

type FiltersDb = D1 & D1Batch;

interface FilterRequest extends AuthRequest {
  env: AuthRequest['env'] & { DB: FiltersDb };
  params?: Record<string, string>;
  text(): Promise<string>;
}

type FilterHandler = (request: FilterRequest) => Promise<Response>;

interface Router {
  get(path: string, handler: FilterHandler): void;
  post(path: string, handler: FilterHandler): void;
  put(path: string, handler: FilterHandler): void;
  delete(path: string, handler: FilterHandler): void;
}

const FILTER_COLUMNS =
  'id, rule_type, pattern, note, is_active, created_by, created_at, updated_at';

const FilterRuleRow = v.object({
  id: v.number(),
  rule_type: v.picklist(Object.values(RULE_TYPE)),
  pattern: v.string(),
  note: v.nullable(v.string()),
  is_active: v.number(),
  created_by: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

type FilterRuleRow = v.InferOutput<typeof FilterRuleRow>;

const ReferencedRow = v.object({ referenced: v.number() });

const CreateBody = v.object({
  rule_type: v.optional(v.unknown()),
  pattern: v.optional(v.unknown()),
  note: v.optional(v.unknown()),
});

const UpdateBody = v.object({
  rule_type: v.optional(v.unknown()),
  pattern: v.optional(v.unknown()),
  note: v.optional(v.unknown()),
  is_active: v.optional(v.unknown()),
});

const HistoryBody = v.object({
  since: v.optional(v.union([v.string(), v.number()])),
  until: v.optional(v.union([v.string(), v.number()])),
  cursor: v.optional(v.unknown()),
});

const HistoryCursorBody = v.object({ created_at: v.string(), id: v.string() });

interface ValidatedRule {
  rule_type: string;
  pattern: string;
  note: string | null;
}

type ValidationResult = ValidatedRule | { error: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Auth0 + RBAC gate. Returns a Response to short-circuit, or null to proceed. */
async function gate(request: FilterRequest, permission: Permission): Promise<Response | null> {
  const authResponse = await handleAuth0(request);
  if (authResponse) return authResponse;
  enrichUserPermissions(request);
  const permResponse = requirePermission(permission)(request);
  if (permResponse) return permResponse;
  return null;
}

async function readBody<T>(request: FilterRequest, schema: Schema<T>): Promise<T> {
  const parsed = await readJson(request, schema);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Validate and normalise a rule payload. */
function validateRule({
  rule_type,
  pattern,
  note,
}: {
  rule_type: unknown;
  pattern: unknown;
  note: unknown;
}): ValidationResult {
  if (typeof rule_type !== 'string' || !VALID_RULE_TYPES.includes(rule_type)) {
    return { error: `rule_type must be one of: ${VALID_RULE_TYPES.join(', ')}` };
  }

  const trimmed = typeof pattern === 'string' ? pattern.trim() : '';
  if (!trimmed) return { error: 'pattern is required' };

  const noteText = typeof note === 'string' ? note.trim() || null : null;

  if (rule_type === RULE_TYPE.BODY_KEYWORD) {
    if (trimmed.length < MIN_KEYWORD_LENGTH) {
      return { error: `body keyword must be at least ${MIN_KEYWORD_LENGTH} characters` };
    }
    return { rule_type, pattern: trimmed, note: noteText };
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
    return { rule_type, pattern: digits, note: noteText };
  }

  return { rule_type, pattern: trimmed, note: noteText };
}

function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(errorText(error));
}

function toDate(value: string | number | undefined): Date {
  return new Date(value ?? Number.NaN);
}

export async function listFilterRules(db: D1<'all'>): Promise<{ filters: FilterRuleRow[] }> {
  const filters = await queryAll(
    db.prepare(
      `SELECT ${FILTER_COLUMNS}
     FROM filter_rules
     ORDER BY rule_type, id`,
    ),
    FilterRuleRow,
  );

  return { filters };
}

export function setupFilterRoutes(router: Router): void {
  // List rule metadata only. Historical hit counts require reading every matched
  // message and are not part of the dashboard's operational rule contract.
  router.get('/api/filters', async (request) => {
    const blocked = await gate(request, 'filters.read');
    if (blocked) return blocked;

    try {
      return json(await listFilterRules(request.env.DB));
    } catch (error) {
      console.error('[filters] list failed:', error);
      return json({ error: 'Failed to fetch filter rules' }, 500);
    }
  });

  // Create a prospective rule. Existing messages remain historical facts.
  router.post('/api/filters', async (request) => {
    const blocked = await gate(request, 'filters.write');
    if (blocked) return blocked;

    try {
      const body = await readBody(request, CreateBody);
      const validated = validateRule({
        rule_type: body.rule_type,
        pattern: body.pattern,
        note: body.note,
      });
      if ('error' in validated) return json({ error: validated.error }, 400);

      const inserted = await queryFirst(
        request.env.DB.prepare(
          `INSERT INTO filter_rules (rule_type, pattern, note, created_by)
         VALUES (?, ?, ?, ?)
         RETURNING ${FILTER_COLUMNS}`,
        ).bind(
          validated.rule_type,
          validated.pattern,
          validated.note,
          // The middleware builds `user.id`; there is no `sub` on it. Reading
          // request.user.sub silently stored null for every rule.
          request.user?.id ?? null,
        ),
        FilterRuleRow,
      );

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
  router.put('/api/filters/:id', async (request) => {
    const blocked = await gate(request, 'filters.write');
    if (blocked) return blocked;

    const id = Number(request.params?.['id']);
    try {
      const existing = await queryFirst(
        request.env.DB.prepare(`SELECT ${FILTER_COLUMNS} FROM filter_rules WHERE id = ?`).bind(id),
        FilterRuleRow,
      );
      if (!existing) return json({ error: 'Filter rule not found' }, 404);

      const body = await readBody(request, UpdateBody);
      if (
        (body.rule_type !== undefined && body.rule_type !== existing.rule_type) ||
        (body.pattern !== undefined &&
          (typeof body.pattern !== 'string' || body.pattern.trim() !== existing.pattern))
      ) {
        return json(
          { error: 'Rule type and pattern are immutable; create a new rule instead' },
          400,
        );
      }
      const validated = validateRule({
        rule_type: existing.rule_type,
        pattern: existing.pattern,
        note: body.note ?? existing.note,
      });
      if ('error' in validated) return json({ error: validated.error }, 400);

      const isActive = body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0;

      const updated = await queryFirst(
        request.env.DB.prepare(
          `UPDATE filter_rules
         SET rule_type = ?, pattern = ?, note = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
         RETURNING ${FILTER_COLUMNS}`,
        ).bind(validated.rule_type, validated.pattern, validated.note, isActive, id),
        FilterRuleRow,
      );

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
  router.delete('/api/filters/:id', async (request) => {
    const blocked = await gate(request, 'filters.delete');
    if (blocked) return blocked;

    const id = Number(request.params?.['id']);
    try {
      const referenced = await queryFirst(
        request.env.DB.prepare(
          `SELECT 1 AS referenced FROM messages WHERE filter_rule_id = ? LIMIT 1`,
        ).bind(id),
        ReferencedRow,
      );
      if (referenced) {
        return json({ error: 'Rule has historical messages; deactivate it instead' }, 409);
      }

      const result = await request.env.DB.prepare(`DELETE FROM filter_rules WHERE id = ?`)
        .bind(id)
        .run();
      if (!result.meta.changes) return json({ error: 'Filter rule not found' }, 404);

      return json({ success: true });
    } catch (error) {
      console.error('[filters] delete failed:', error);
      return json({ error: 'Failed to delete filter rule' }, 500);
    }
  });

  // Historical changes are explicit, bounded, and one page per operator action.
  router.post('/api/filters/:id/history', async (request) => {
    const blocked = await gate(request, 'filters.write');
    if (blocked) return blocked;

    const id = Number(request.params?.['id']);
    try {
      const rule = await queryFirst(
        request.env.DB.prepare(`SELECT ${FILTER_COLUMNS} FROM filter_rules WHERE id = ?`).bind(id),
        FilterRuleRow,
      );
      if (!rule) return json({ error: 'Filter rule not found' }, 404);

      const body = await readBody(request, HistoryBody);
      const since = toDate(body.since);
      const until = toDate(body.until);
      if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since > until) {
        return json({ error: 'A valid history time range is required' }, 400);
      }
      const rawCursor = body.cursor ?? null;
      let cursor: HistoryCursor | null = null;
      if (rawCursor !== null) {
        const parsed = v.safeParse(HistoryCursorBody, rawCursor);
        if (!parsed.success || Number.isNaN(new Date(`${parsed.output.created_at}Z`).getTime())) {
          return json({ error: 'Invalid history cursor' }, 400);
        }
        cursor = parsed.output;
      }

      const result = await processRuleHistoryPage(request.env.DB, rule, {
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
