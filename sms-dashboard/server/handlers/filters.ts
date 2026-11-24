// Spam/marketing filter rule management.
//
// Rule mutations affect new ingestion only. Historical changes are a separate,
// explicitly requested, one-page-at-a-time operation. Nothing here decides what
// spam is — see utils/spam-filter.ts.

import { ORPCError } from '@orpc/server';
import type * as v from 'valibot';
import {
  IMMUTABLE_RULE_MESSAGE,
  PATTERN_MESSAGE,
  RULE_TYPE,
  type CreateFilterBody,
  type FilterResponse,
  type FiltersResponse,
  type RuleType,
  type UpdateFilterBody,
} from '../../shared/api/filters.js';
import type { HistoryRequestBody, RuleHistoryPage } from '../../shared/api/history.js';
import type { SuccessResponse } from '../../shared/api/success.js';
import { errorText } from '../../shared/error-text.js';
import {
  deleteFilter,
  findFilter,
  insertFilter,
  isFilterReferenced,
  listFilters,
  updateFilter,
} from '../db/filters.js';
import type { D1, D1Batch } from '../lib/d1.js';
import { normalizeSender } from '../utils/spam-filter.js';
import { processRuleHistoryPage } from '../utils/filter-history.js';

/** Shortest allowed body keyword. A single character would hide almost everything. */
const MIN_KEYWORD_LENGTH = 2;

/** Shortest allowed sender pattern, so a stray '1' cannot match half the table. */
const MIN_SENDER_LENGTH = 3;

interface FiltersCall {
  env: { DB: D1 & D1Batch };
  user?: { id: string } | undefined;
}

interface ValidatedRule {
  rule_type: RuleType;
  pattern: string;
  note: string | null;
}

type ValidationResult = ValidatedRule | { error: string };

/** Validate and normalise a rule payload. */
function validateRule({
  rule_type,
  pattern,
  note,
}: {
  rule_type: RuleType;
  pattern: string;
  note: string | null | undefined;
}): ValidationResult {
  const trimmed = pattern.trim();
  if (!trimmed) return { error: PATTERN_MESSAGE };

  const trimmedNote = note?.trim();
  const noteText = trimmedNote === undefined || trimmedNote === '' ? null : trimmedNote;

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

export async function listFilterRules(db: D1<'all'>): Promise<FiltersResponse> {
  const filters = await listFilters(db);

  return { filters };
}

/**
 * Answers `error`: a refusal a handler chose stands, a duplicate
 * rule is a conflict, and anything else is logged and answered as `message`.
 */
function fail(error: unknown, label: string, message: string): never {
  if (error instanceof ORPCError) throw error;
  if (isUniqueViolation(error)) {
    throw new ORPCError('CONFLICT', { message: 'That rule already exists' });
  }
  console.error(`[filters] ${label}:`, error);
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message });
}

function notFound(): ORPCError<'NOT_FOUND', unknown> {
  return new ORPCError('NOT_FOUND', { message: 'Filter rule not found' });
}

function validated(rule: Parameters<typeof validateRule>[0]): ValidatedRule {
  const result = validateRule(rule);
  if ('error' in result) throw new ORPCError('BAD_REQUEST', { message: result.error });
  return result;
}

/** The rule `id` names: an id that is not a number names none. */
function ruleId(id: string): number {
  return Number(id);
}

export const filtersHandler = {
  // List rule metadata only. Historical hit counts require reading every matched
  // message and are not part of the dashboard's operational rule contract.
  async list({ env }: FiltersCall): Promise<FiltersResponse> {
    try {
      return await listFilterRules(env.DB);
    } catch (error) {
      fail(error, 'list failed', 'Failed to fetch filter rules');
    }
  },

  // Create a prospective rule. Existing messages remain historical facts.
  async create(
    { env, user }: FiltersCall,
    body: v.InferOutput<typeof CreateFilterBody>,
  ): Promise<FilterResponse> {
    try {
      const rule = validated({ rule_type: body.rule_type, pattern: body.pattern, note: body.note });
      const inserted = await insertFilter(env.DB, {
        rule_type: rule.rule_type,
        pattern: rule.pattern,
        note: rule.note,
        // The middleware builds `user.id`; there is no `sub` on it. Reading
        // request.user.sub silently stored null for every rule.
        created_by: user?.id ?? null,
      });
      return { filter: inserted };
    } catch (error) {
      fail(error, 'create failed', 'Failed to create filter rule');
    }
  },

  // Matching identity is immutable. Notes and prospective active state may change.
  async update(
    { env }: FiltersCall,
    id: string,
    body: v.InferOutput<typeof UpdateFilterBody>,
  ): Promise<FilterResponse> {
    try {
      const existing = await findFilter(env.DB, ruleId(id));
      if (!existing) throw notFound();
      if (
        (body.rule_type !== undefined && body.rule_type !== existing.rule_type) ||
        (body.pattern !== undefined && body.pattern.trim() !== existing.pattern)
      ) {
        throw new ORPCError('BAD_REQUEST', { message: IMMUTABLE_RULE_MESSAGE });
      }
      const rule = validated({
        rule_type: existing.rule_type,
        pattern: existing.pattern,
        note: body.note ?? existing.note,
      });

      const isActive = body.is_active === undefined ? existing.is_active : body.is_active ? 1 : 0;

      const updated = await updateFilter(env.DB, ruleId(id), {
        rule_type: rule.rule_type,
        pattern: rule.pattern,
        note: rule.note,
        is_active: isActive,
      });
      if (!updated) throw notFound();
      return { filter: updated };
    } catch (error) {
      fail(error, 'update failed', 'Failed to update filter rule');
    }
  },

  // A referenced rule is historical provenance and cannot be physically deleted.
  async remove({ env }: FiltersCall, id: string): Promise<SuccessResponse> {
    try {
      if (await isFilterReferenced(env.DB, ruleId(id))) {
        throw new ORPCError('CONFLICT', {
          message: 'Rule has historical messages; deactivate it instead',
        });
      }

      const changes = await deleteFilter(env.DB, ruleId(id));
      if (!changes) throw notFound();
      return { success: true };
    } catch (error) {
      fail(error, 'delete failed', 'Failed to delete filter rule');
    }
  },

  // Historical changes are explicit, bounded, and one page per operator action.
  async history(
    { env }: FiltersCall,
    id: string,
    { since, until, cursor }: v.InferOutput<typeof HistoryRequestBody>,
  ): Promise<RuleHistoryPage> {
    try {
      const rule = await findFilter(env.DB, ruleId(id));
      if (!rule) throw notFound();
      return await processRuleHistoryPage(env.DB, rule, {
        since: since.toISOString(),
        until: until.toISOString(),
        cursor: cursor ?? null,
      });
    } catch (error) {
      fail(error, 'history processing failed', 'Failed to process filter history');
    }
  },
};
